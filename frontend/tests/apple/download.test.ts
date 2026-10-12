import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { listVersions } from '../../src/apple/versionFinder';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { appleRequest } from '../../src/apple/request';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import type { Account, Software } from '../../src/types';
import type { AppleResponse } from '../../src/apple/request';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({
  fetchBag: async () => ({
    redownloadURL: 'https://downloaddispatch.itunes.apple.com/r/redownload',
    updateURL: 'https://downloaddispatch.itunes.apple.com/up/updateProduct',
  }),
}));

const account = {
  email: 'test@example.com',
  store: '143465',
  pod: '25',
  deviceIdentifier: 'aabbccddeeff',
  directoryServicesIdentifier: 'test-dsid',
  cookies: [],
} as Account;
// Public App Store identity and catalog version for 慕课网; responses below
// are synthetic fixtures, not captured account/session data.
const app = { id: 722179140, bundleID: 'com.mukewang.mukewang' } as Software;
const version = '892069770';
const metadata = {
  itemId: app.id,
  softwareVersionBundleId: app.bundleID,
  softwareVersionExternalIdentifier: version,
  softwareVersionExternalIdentifiers: ['100', version],
  bundleShortVersionString: '8.8.6',
  bundleVersion: '80806',
  releaseDate: '2026-10-01T00:00:00Z',
  passwordToken: 'fixture-only',
};
const response = (body: string, status = 200): AppleResponse => ({
  status,
  body,
  statusText: '',
  headers: {},
  rawHeaders: [],
});
const success = (overrides = {}) =>
  response(
    buildPlist({
      songList: [
        {
          URL: 'https://example.apple.com/fixture.ipa',
          metadata: { ...metadata, ...overrides },
          sinfs: [{ id: 0, sinf: new Uint8Array([1, 2, 3]) }],
        },
      ],
    }),
  );
const catalog = (
  items: unknown = {
    [app.id]: {
      bundleId: app.bundleID,
      offers: [
        {
          assets: [{ flavor: 'iosSoftware' }],
          version: { externalId: version },
        },
      ],
    },
  },
) => response(JSON.stringify({ results: items }));

beforeEach(() => {
  vi.mocked(appleRequest).mockReset();
});

describe('download and history recovery', () => {
  it.each(['download', 'list', 'metadata'] as const)(
    'recovers the %s entry point through pinned updateProduct',
    async (operation) => {
      vi.mocked(appleRequest).mockImplementation(async (request) => {
        if (request.host === 'uclient-api.itunes.apple.com') {
          expect(request.cookies).toBeUndefined();
          expect(request.headers).toBeUndefined();
          expect(request.path).toContain('platform=enterprisestore');
          expect(request.path).toContain('cc=cn');
          return catalog();
        }
        if (request.path.includes('volumeStoreDownloadProduct'))
          return response(buildPlist({ songList: [] }));
        expect(parsePlist(request.body!)).toMatchObject({
          appExtVrsId: version,
        });
        if (request.path.startsWith('/r/redownload')) return response('', 500);
        expect(request.path).toMatch(/^\/up\/updateProduct\?/);
        return success();
      });
      if (operation === 'download') {
        const result = await getDownloadInfo(account, app);
        expect(result.output.sinfs).toEqual([{ id: 0, sinf: 'AQID' }]);
        const xml = atob(result.output.iTunesMetadata!);
        expect(parsePlist(xml).passwordToken).toBeUndefined();
        expect(result.output.bundleShortVersionString).toBe('8.8.6');
      } else if (operation === 'list') {
        expect((await listVersions(account, app)).versions).toEqual([
          version,
          '100',
        ]);
      } else {
        expect(
          (await getVersionMetadata(account, app, version)).metadata
            .displayVersion,
        ).toBe('8.8.6');
        expect(
          vi
            .mocked(appleRequest)
            .mock.calls.some(([request]) => request.method === 'GET'),
        ).toBe(false);
      }
    },
  );

  it('tries the consumer iPhone catalog if the enterprise catalog has no app', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(buildPlist({ songList: [] })))
      .mockResolvedValueOnce(catalog({}))
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(success());
    await getDownloadInfo(account, app);
    expect(vi.mocked(appleRequest).mock.calls[2][0].path).toContain(
      'platform=iphone',
    );
    expect(vi.mocked(appleRequest).mock.calls[2][0].path).toContain('cc=cn');
  });

  it('preserves cookies from primary and relative dispatch redirects', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        ...response(buildPlist({ songList: [] })),
        rawHeaders: [['set-cookie', 'storeSession=fixture; Path=/; Secure']],
      })
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce({
        ...response('', 307),
        headers: { location: '/r/redownload?guid=aabbccddeeff&route=opaque' },
        rawHeaders: [['set-cookie', 'dispatchSession=fixture; Path=/; Secure']],
      })
      .mockResolvedValueOnce(success());
    const result = await getDownloadInfo(account, app);
    const last = vi.mocked(appleRequest).mock.calls[3][0];
    expect(last.path).toContain('route=opaque');
    expect(last.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'storeSession' }),
        expect.objectContaining({ name: 'dispatchSession' }),
      ]),
    );
    expect(result.updatedCookies).toHaveLength(2);
  });

  it.each(['2034', '2042', '9610'])(
    'preserves structured failure %s without a recovery request',
    async (failureType) => {
      vi.mocked(appleRequest).mockResolvedValue(
        response(buildPlist({ failureType })),
      );
      await expect(getDownloadInfo(account, app)).rejects.toMatchObject({
        code: failureType,
      });
      expect(appleRequest).toHaveBeenCalledOnce();
    },
  );

  it('does not hide a license error from redownload by trying updateProduct', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(buildPlist({ songList: [] })))
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(response(buildPlist({ failureType: '9610' })));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({
      code: '9610',
    });
    expect(appleRequest).toHaveBeenCalledTimes(3);
  });

  it('stops after all three download endpoints return empty lists', async () => {
    vi.mocked(appleRequest).mockImplementation(async (request) =>
      request.method === 'GET'
        ? catalog()
        : response(buildPlist({ songList: [] })),
    );
    await expect(getDownloadInfo(account, app)).rejects.toThrow('No items');
    expect(appleRequest).toHaveBeenCalledTimes(4);
  });

  it('retains actionable message-only errors without automatic purchase', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      response(buildPlist({ customerMessage: 'Account is disabled' })),
    );
    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      'Account is disabled',
    );
    expect(appleRequest).toHaveBeenCalledOnce();
  });
});
