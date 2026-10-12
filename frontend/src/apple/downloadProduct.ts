import i18n from '../i18n';
import { fetchBag } from './bag';
import { extractAndMergeCookies } from './cookies';
import { buildPlist, parsePlist } from './plist';
import { appleRequest } from './request';
import {
  redownloadEndpoint,
  storeIdToCountry,
  volumeStoreEndpoint,
} from './config';
import type { StoreDownloadEndpoint } from './config';
import type { AppleResponse } from './request';
import type { Account, Software } from '../types';

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

// Only the observed empty/unavailable responses permit endpoint recovery.
// Authentication, license, and other structured failures must not be hidden.
export function needsDownloadFallback(dict: Record<string, any>): boolean {
  if (dict.songList?.length) return false;
  if (dict.failureType) return String(dict.failureType) === '5002';
  const message = String(dict.customerMessage ?? '')
    .trim()
    .toLowerCase();
  return (
    !message ||
    message === 'no longer available' ||
    message.endsWith(' no longer available')
  );
}

export function dispatchEndpoint(
  raw: string,
  kind: 'redownload' | 'update',
  deviceId: string,
): StoreDownloadEndpoint {
  const url = new URL(raw);
  const path = kind === 'redownload' ? '/r/redownload' : '/up/updateProduct';
  if (
    url.protocol !== 'https:' ||
    url.host !== 'downloaddispatch.itunes.apple.com' ||
    url.pathname !== path ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new DownloadError('Invalid download endpoint in Apple bag');
  }
  url.searchParams.set('guid', deviceId);
  return {
    host: url.hostname,
    path: url.pathname + url.search,
    externalVersionIdKey: 'appExtVrsId',
  };
}

async function latestIOSVersion(
  account: Account,
  app: Software,
): Promise<string> {
  const country = storeIdToCountry(account.store.split('-')[0]);
  if (!country) throw new DownloadError('Unknown account storefront');
  for (const platform of ['enterprisestore', 'iphone', 'ipad']) {
    const params = new URLSearchParams({
      version: '2',
      id: String(app.id),
      p: 'mdm-lockup',
      caller: 'MDM',
      platform,
      cc: country.toLowerCase(),
      l: 'en',
    });
    const response = await appleRequest({
      method: 'GET',
      host: 'uclient-api.itunes.apple.com',
      path: `/WebObjects/MZStorePlatform.woa/wa/lookup?${params}`,
    });
    if (response.status !== 200)
      throw new DownloadError(`iOS version lookup: HTTP ${response.status}`);
    const item = JSON.parse(response.body).results?.[String(app.id)];
    if (!item) continue;
    if (app.bundleID && item.bundleId !== app.bundleID) {
      throw new DownloadError('iOS version lookup returned a different app');
    }
    const offer = Array.isArray(item.offers)
      ? item.offers.find((o: any) =>
          o.assets?.some((a: any) => a.flavor === 'iosSoftware'),
        )
      : undefined;
    if (!offer) continue;
    const version = String(
      offer?.version?.externalId ??
        new URLSearchParams(offer?.buyParams).get('appExtVrsId') ??
        '',
    );
    if (/^[1-9]\d*$/.test(version)) return version;
  }
  throw new DownloadError('No iOS version available in the account storefront');
}

function responseDict(
  response: AppleResponse,
  endpoint: StoreDownloadEndpoint,
): Record<string, any> {
  const label = endpoint.path.split('?')[0];
  if (response.status !== 200)
    throw new DownloadError(
      `${label}: HTTP ${response.status}${response.body.trim() ? '' : ' (empty response)'}`,
    );
  try {
    const dict = parsePlist(response.body);
    if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
      throw new Error('Not a dictionary');
    }
    return dict;
  } catch {
    throw new DownloadError(
      `${label}: HTTP ${response.status}, invalid plist response`,
    );
  }
}

function requireItems(dict: Record<string, any>): void {
  const code = String(dict.failureType ?? '');
  if (dict.customerMessage === 'Your password has changed.') {
    throw new DownloadError(
      i18n.t('errors.download.passwordExpired'),
      code || '2034',
    );
  }
  if (code) {
    if (['2034', '2042'].includes(code)) {
      throw new DownloadError(i18n.t('errors.download.passwordExpired'), code);
    }
    if (code === '9610')
      throw new DownloadError(i18n.t('errors.download.licenseRequired'), code);
    throw new DownloadError(
      `${dict.customerMessage || 'Apple download failed'} (${code})`,
      code,
    );
  }
  if (!Array.isArray(dict.songList) || !dict.songList.length) {
    throw new DownloadError(
      dict.customerMessage || i18n.t('errors.download.noItems'),
    );
  }
}

function validateDownloadItem(
  dict: Record<string, any>,
  app: Software,
  version?: string,
  strict = true,
): void {
  const metadata = dict.songList[0]?.metadata;
  if (
    dict.songList.length !== 1 ||
    (strict && !metadata) ||
    ((strict || metadata?.itemId !== undefined) &&
      String(metadata?.itemId) !== String(app.id)) ||
    (version &&
      (strict || metadata?.softwareVersionExternalIdentifier !== undefined) &&
      String(metadata?.softwareVersionExternalIdentifier) !== version) ||
    (strict && !metadata?.softwareVersionBundleId) ||
    (app.bundleID &&
      metadata?.softwareVersionBundleId !== undefined &&
      metadata.softwareVersionBundleId !== app.bundleID)
  ) {
    throw new DownloadError(
      'Apple download response does not match the requested app/version',
    );
  }
}

/**
 * Shared protocol for downloads, version lists, and pinned version metadata.
 * Recovery follows upstream PR #90; catalog fallback follows PR #92.
 */
export async function downloadProduct(
  account: Account,
  app: Software,
  versionId?: string,
) {
  let cookies = [...account.cookies];
  const send = async (
    endpoint: StoreDownloadEndpoint,
    version?: string,
  ): Promise<AppleResponse> => {
    const payload: Record<string, unknown> = {
      creditDisplay: '',
      guid: account.deviceIdentifier,
      salableAdamId: app.id,
      serialNumber: '0',
    };
    if (version) payload[endpoint.externalVersionIdKey] = version;
    let host = endpoint.host;
    let path = endpoint.path;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await appleRequest({
        method: 'POST',
        host,
        path,
        headers: {
          'Content-Type': 'application/x-apple-plist',
          'iCloud-DSID': account.directoryServicesIdentifier,
          'X-Dsid': account.directoryServicesIdentifier,
        },
        body: buildPlist(payload),
        cookies,
      });
      cookies = extractAndMergeCookies(response.rawHeaders, cookies);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (!response.headers.location)
        throw new DownloadError('Missing Apple download redirect location');
      const url = new URL(response.headers.location, `https://${host}${path}`);
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        !/^(?:(?:p\d+-)?buy|downloaddispatch)\.itunes\.apple\.com$/.test(
          url.hostname,
        )
      ) {
        throw new DownloadError('Unsafe Apple download redirect');
      }
      host = url.hostname;
      path = url.pathname + url.search;
    }
    throw new DownloadError(i18n.t('errors.download.tooManyRedirects'));
  };

  const primary = volumeStoreEndpoint(account.pod, account.deviceIdentifier);
  let dict = responseDict(await send(primary, versionId), primary);
  if (!needsDownloadFallback(dict)) {
    requireItems(dict);
    validateDownloadItem(dict, app, versionId, false);
    return { dict, updatedCookies: cookies };
  }

  const bag = await fetchBag(account.deviceIdentifier);
  // An unpinned dispatch request may return HTTP 500 or the tvOS build.
  const pinnedVersion = versionId || (await latestIOSVersion(account, app));
  const redownload = bag.redownloadURL
    ? dispatchEndpoint(
        bag.redownloadURL,
        'redownload',
        account.deviceIdentifier,
      )
    : redownloadEndpoint(account.deviceIdentifier);
  const response = await send(redownload, pinnedVersion);
  const emptyServerError = response.status === 500 && !response.body.trim();
  if (!emptyServerError) dict = responseDict(response, redownload);
  const recoverable = !emptyServerError && needsDownloadFallback(dict);

  if (bag.updateURL && (emptyServerError || recoverable)) {
    const update = dispatchEndpoint(
      bag.updateURL,
      'update',
      account.deviceIdentifier,
    );
    dict = responseDict(await send(update, pinnedVersion), update);
  } else if (emptyServerError) {
    responseDict(response, redownload); // Preserve the HTTP failure, not an XML parser error.
  }
  requireItems(dict);
  validateDownloadItem(dict, app, pinnedVersion);
  return { dict, updatedCookies: cookies };
}
