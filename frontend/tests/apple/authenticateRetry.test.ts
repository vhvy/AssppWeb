import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../src/i18n';
import { buildPlist } from '../../src/apple/plist';
import { authenticate } from '../../src/apple/authenticate';
import { appleRequest } from '../../src/apple/request';
import { fetchBag } from '../../src/apple/bag';
import { prepareSigner, signWithSap } from '../../src/apple/sap/client';

vi.mock('../../src/apple/request', () => ({
  appleRequest: vi.fn(),
}));

vi.mock('../../src/apple/sap/client', () => ({
  prepareSigner: vi.fn(),
  signWithSap: vi.fn(),
}));

vi.mock('../../src/apple/bag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apple/bag')>()),
  fetchBag: vi.fn(),
}));

describe('apple/authenticate transient responses', () => {
  const accountReply = () => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    rawHeaders: [],
    body: buildPlist({
      accountInfo: { address: {} },
      passwordToken: 'token',
      dsPersonId: '123',
    }),
  });
  const transientReply = (
    status: number,
    headers: Record<string, string> = {},
  ) => ({
    status,
    statusText: '',
    headers,
    rawHeaders: [],
    body: '',
  });
  const login = (onRetry?: Parameters<typeof authenticate>[5]) =>
    authenticate(
      'test@example.com',
      'password',
      undefined,
      undefined,
      'aabbccddeeff',
      onRetry,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays a 204 after 10s and reports the wait', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(transientReply(204))
      .mockResolvedValueOnce(accountReply());
    const onRetry = vi.fn();

    const account = login(onRetry);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(account).resolves.toMatchObject({ passwordToken: 'token' });
    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith({
      status: 204,
      attempt: 2,
      attempts: 3,
      delayMs: 10_000,
    });
  });

  it('gives up after three transient responses without stacking retries', async () => {
    vi.mocked(appleRequest).mockResolvedValue(transientReply(204));

    const account = login();
    const assertion = expect(account).rejects.toThrow('204, 204, 204');
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    expect(appleRequest).toHaveBeenCalledTimes(3);
  });

  it('waits as long as Retry-After asks, within 30s', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(transientReply(429, { 'retry-after': '5' }))
      .mockResolvedValueOnce(accountReply());
    const onRetry = vi.fn();

    const account = login(onRetry);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(account).resolves.toBeDefined();
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, delayMs: 5_000 }),
    );
  });

  it('stops when Apple asks to wait longer than 30s', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      transientReply(503, { 'retry-after': '120' }),
    );

    await expect(login()).rejects.toThrow(
      i18n.t('errors.auth.retryLater', { seconds: 120 }),
    );
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('normalizes the URL and freshly signs each replay while preserving cookies', async () => {
    const sapEndpoints = {
      setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
      certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
      version: 200,
    };
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=old&routing=a%2Fb',
      sapEndpoints,
    });
    vi.mocked(signWithSap)
      .mockResolvedValueOnce('first-signature')
      .mockResolvedValueOnce('second-signature');
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        ...transientReply(204),
        rawHeaders: [['set-cookie', 'session=retry; Path=/; Secure']],
      })
      .mockResolvedValueOnce(accountReply());

    const result = login();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeDefined();
    expect(prepareSigner).toHaveBeenCalledWith('aabbccddeeff', sapEndpoints);
    const requests = vi
      .mocked(appleRequest)
      .mock.calls.map(([request]) => request);
    expect(
      requests.map((request) => request.headers?.['X-Apple-ActionSignature']),
    ).toEqual(['first-signature', 'second-signature']);
    expect(requests[0].path).toBe(
      '/WebObjects/MZFinance.woa/wa/authenticate/?guid=aabbccddeeff&routing=a%2Fb',
    );
    expect(requests[1].cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'session', value: 'retry' }),
      ]),
    );
    for (let i = 0; i < requests.length; i++) {
      expect(signWithSap).toHaveBeenNthCalledWith(
        i + 1,
        'aabbccddeeff',
        sapEndpoints,
        new TextEncoder().encode(requests[i].body),
      );
    }
  });

  it('honors an HTTP-date Retry-After', async () => {
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(
        transientReply(429, { 'retry-after': 'Sun, 11 Oct 2026 12:00:07 GMT' }),
      )
      .mockResolvedValueOnce(accountReply());
    const onRetry = vi.fn();
    const result = login(onRetry);
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(result).resolves.toBeDefined();
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 7_000 }),
    );
  });
});
