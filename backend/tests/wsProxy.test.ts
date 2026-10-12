import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import net from 'net';
import { WebSocket } from 'ws';
import express from 'express';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import { setupWsProxy } from '../src/services/wsProxy.js';

let httpServer: Server | null = null;
let serverPort: number;

async function startServer() {
  const app = express();
  httpServer = createServer(app);
  setupWsProxy(httpServer);

  await new Promise<void>((resolve) => {
    httpServer!.listen(0, () => {
      serverPort = (httpServer!.address() as net.AddressInfo).port;
      resolve();
    });
  });
}

async function stopServer() {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe('Wisp Proxy', () => {
  it('allows SAP setup hosts while retaining port and hostname restrictions', () => {
    const allows = (host: string) =>
      wisp.options.hostname_whitelist.some((pattern: RegExp) =>
        pattern.test(host),
      );
    expect(allows('fpinit.itunes.apple.com')).toBe(true);
    expect(allows('s.mzstatic.com')).toBe(true);
    expect(allows('uclient-api.itunes.apple.com')).toBe(true);
    expect(allows('example.com')).toBe(false);
    expect(allows('s.mzstatic.com.example.com')).toBe(false);
    expect(wisp.options.port_whitelist).toEqual([443]);
    expect(wisp.options.allow_direct_ip).toBe(false);
  });
  afterEach(async () => {
    await stopServer();
  });

  it('should accept WebSocket connections on /wisp/ path', async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/wisp/`);

    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  it('should reject connections on non-wisp paths', async () => {
    await startServer();

    const ws = new WebSocket(
      `ws://127.0.0.1:${serverPort}/proxy?host=buy.itunes.apple.com&port=443`,
    );

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true));
      ws.on('close', () => resolve(true));
      ws.on('open', () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });

  it('should reject connections on random paths', async () => {
    await startServer();

    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/other`);

    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true));
      ws.on('close', () => resolve(true));
      ws.on('open', () => {
        ws.close();
        resolve(false);
      });
    });

    expect(rejected).toBe(true);
  });
});
