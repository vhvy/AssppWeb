import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import sapRoutes from '../src/routes/sapAssets.js';
import { ensureSapAssets, readCachedAsset } from '../src/services/sapAssets.js';

vi.mock('../src/services/sapAssets.js', () => ({
  SAP_ASSET_SPECS: [{ name: 'CoreFP', strippedSha256: 'pinned-digest' }],
  ensureSapAssets: vi.fn(),
  readCachedAsset: vi.fn(),
  sapAssetsState: () => ({ status: 'idle' }),
}));

const app = express();
app.use('/api', sapRoutes);

describe('SAP public asset routes', () => {
  beforeEach(() => vi.resetAllMocks());

  it('serves a fixed, verified asset after preparation', async () => {
    vi.mocked(readCachedAsset)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from('asset'));
    const response = await request(app).get('/api/sap-assets/CoreFP');
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"pinned-digest"');
    expect(response.body).toEqual(Buffer.from('asset'));
    expect(ensureSapAssets).toHaveBeenCalledTimes(1);
  });

  it('rejects filenames outside the fixed asset list without fetching', async () => {
    const response = await request(app).get('/api/sap-assets/unknown');
    expect(response.status).toBe(404);
    expect(readCachedAsset).not.toHaveBeenCalled();
    expect(ensureSapAssets).not.toHaveBeenCalled();
  });

  it('returns a recoverable error instead of an unhandled rejection', async () => {
    vi.mocked(readCachedAsset).mockRejectedValue(new Error('disk unavailable'));
    const response = await request(app).get('/api/sap-assets/CoreFP');
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('disk unavailable');
  });
});
