import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SapSigner } from '../../src/apple/sap/signer';

vi.mock('../../src/apple/sap/assets', () => ({
  loadSapAssets: vi.fn(async () => ({
    commerceKit: new Uint8Array(1),
    commerceCore: new Uint8Array(1),
    coreFP: new Uint8Array(1),
    coreFPICXS: new Uint8Array(1),
  })),
}));
vi.mock('../../src/apple/sap/signer', () => ({
  SapSigner: { create: vi.fn() },
}));
vi.mock('../../src/apple/sap/protocol', () => ({
  fetchSetupCertificate: vi.fn(),
  exchangeSetupBuffer: vi.fn(),
}));

const events: string[] = [];
class TestWorker {
  static stall = false;
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage(request: { type: string; id: number }) {
    events.push(request.type);
    if (!TestWorker.stall) {
      queueMicrotask(() =>
        this.onmessage?.({ data: { type: 'result', id: request.id } }),
      );
    }
  }
}
const endpoints = {
  setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
  certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
  version: 200,
};

describe('SAP worker lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    events.length = 0;
    TestWorker.stall = false;
    vi.stubGlobal('Worker', TestWorker);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      })),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reuses preparation for the same account and serializes its signatures', async () => {
    const sign = vi.fn(async () => 'signature');
    vi.mocked(SapSigner.create).mockResolvedValue({
      sign,
    } as unknown as SapSigner);
    const { signWithSap } = await import('../../src/apple/sap/client');
    await Promise.all([
      signWithSap('aabbccddeeff', endpoints, new Uint8Array([1])),
      signWithSap('aabbccddeeff', endpoints, new Uint8Array([2])),
    ]);
    expect(SapSigner.create).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('does not close one account worker while its signature is in flight', async () => {
    let release: (() => void) | undefined;
    vi.mocked(SapSigner.create).mockResolvedValue({
      sign: async () => {
        if (!release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        events.push('signed');
        return 'signature';
      },
    } as unknown as SapSigner);
    const { signWithSap } = await import('../../src/apple/sap/client');
    const first = signWithSap('aabbccddeeff', endpoints, new Uint8Array([1]));
    const second = signWithSap('112233445566', endpoints, new Uint8Array([2]));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(events).not.toContain('close');
    release!();
    await Promise.all([first, second]);
    expect(events.indexOf('signed')).toBeLessThan(events.indexOf('close'));
  });

  it('times out a stalled worker and permits a new preparation', async () => {
    vi.useFakeTimers();
    TestWorker.stall = true;
    const { prepareSigner } = await import('../../src/apple/sap/client');
    const result = prepareSigner('aabbccddeeff', endpoints);
    const assertion = expect(result).rejects.toThrow('SAP worker timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    TestWorker.stall = false;
    vi.mocked(SapSigner.create).mockResolvedValue({
      sign: vi.fn(),
    } as unknown as SapSigner);
    await expect(
      prepareSigner('aabbccddeeff', endpoints),
    ).resolves.toBeDefined();
  });
});
