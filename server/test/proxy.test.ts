import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { activeProxy, chromeProxy, proxyUrl, setupProxy } from '../src/proxy.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-proxy-'));

const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(vars: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setGlobalDispatcher(new Agent());
});

describe('proxy settings from the environment', () => {
  it('prefers HTTPS_PROXY and ignores "none"', () => {
    setEnv({ HTTPS_PROXY: 'none', https_proxy: 'http://a:1', HTTP_PROXY: 'http://b:2' });
    expect(proxyUrl()).toBe('http://a:1');
    setEnv({});
    expect(proxyUrl()).toBeUndefined();
    expect(chromeProxy()).toBeUndefined();
  });

  it('gives Chrome the server, bypass list and decoded credentials', () => {
    setEnv({ HTTPS_PROXY: 'http://corp%5Cjo:p%40ss@proxy.corp:8080/', NO_PROXY: 'localhost,.corp.local' });
    expect(chromeProxy()).toEqual({
      server: 'http://proxy.corp:8080',
      bypass: 'localhost,.corp.local',
      username: 'corp\\jo',
      password: 'p@ss',
    });
    setEnv({ http_proxy: 'proxy.corp:3128' });
    expect(chromeProxy()).toMatchObject({ server: 'http://proxy.corp:3128', username: undefined });
  });

  it('accepts a proxy without a scheme and ignores ones fetch() cannot use', () => {
    setEnv({ HTTPS_PROXY: 'proxy.corp:8080', http_proxy: 'proxy.corp:8080' });
    expect(setupProxy()).toBe('http://proxy.corp:8080');
    expect(process.env.http_proxy).toBe('http://proxy.corp:8080');
    setEnv({ HTTPS_PROXY: 'socks5://proxy.corp:1080' });
    expect(setupProxy()).toBeUndefined();
  });

  it('routes fetch() through the proxy and honours NO_PROXY', async () => {
    const seen: string[] = [];
    const upstream = http.createServer((_req, res) => res.end('via-proxy'));
    const direct = http.createServer((_req, res) => res.end('direct'));
    const proxy = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.end('via-proxy');
    });
    proxy.on('connect', (req, client) => {
      seen.push(req.url ?? '');
      const tunnel = net.connect((upstream.address() as AddressInfo).port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnel.pipe(client).pipe(tunnel);
      });
      tunnel.on('error', () => client.destroy());
      client.on('error', () => tunnel.destroy());
    });
    const servers = [upstream, direct, proxy];
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const proxyPort = (proxy.address() as AddressInfo).port;
    const directPort = (direct.address() as AddressInfo).port;
    try {
      setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1' });
      expect(setupProxy()).toBe(`http://127.0.0.1:${proxyPort}`);
      expect(await (await fetch('http://models.example.invalid/v1/models')).text()).toBe('via-proxy');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^(http:\/\/)?models\.example\.invalid(:80)?(\/v1\/models)?$/);
      expect(await (await fetch(`http://127.0.0.1:${directPort}/`)).text()).toBe('direct');
      expect(seen).toHaveLength(1);
    } finally {
      setGlobalDispatcher(new Agent());
      for (const s of servers) {
        s.closeAllConnections();
        s.close();
      }
    }
  });

  it('reports the active proxy without its credentials', () => {
    setEnv({ HTTPS_PROXY: 'http://jo:secret@proxy.corp:8080' });
    setupProxy();
    expect(activeProxy()).toBe('http://***@proxy.corp:8080');
    setEnv({ HTTPS_PROXY: 'socks5://proxy.corp:1080' });
    setupProxy();
    expect(activeProxy()).toBeUndefined();
    setEnv({});
    setupProxy();
    expect(activeProxy()).toBeUndefined();
  });

  it('endpoints with "use system proxy" off connect directly, even to addresses the proxy cannot reach', async () => {
    const { chatWithEndpoint } = await import('../src/llm.js');
    const seen: string[] = [];
    const model = http.createServer(async (req, res) => {
      for await (const _ of req);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'local model' } }] }));
    });
    // Like a corporate proxy that has no route into the local network.
    const proxy = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(502).end('proxy cannot reach this host');
    });
    proxy.on('connect', (req, client) => {
      seen.push(req.url ?? '');
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    const servers = [model, proxy];
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
    const ep = (useProxy: number, baseUrl = modelUrl) => ({
      id: 0,
      name: '本地模型',
      base_url: baseUrl,
      api_key: 'k',
      model: 'local',
      priority: 1,
      enabled: 1,
      extra_body: '{}',
      max_concurrency: 0,
      use_proxy: useProxy,
      last_test_at: null,
      last_test_ok: null,
      last_test_message: null,
      created_at: 0,
    });
    const hi = [{ role: 'user' as const, content: 'hi' }];
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      setEnv({ HTTP_PROXY: proxyUrl });
      setupProxy();
      const viaProxy = await chatWithEndpoint(ep(1), hi, 'u').catch((e: Error) => e);
      expect(String(viaProxy)).toMatch(/无法连接接入点 本地模型|HTTP 502/);
      expect(String(viaProxy)).toContain(`请求经过系统代理 ${proxyUrl}；模型部署在本机或内网、代理访问不到时，请在「模型接入」中关闭这个接入点的「使用系统代理」`);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(new URL(modelUrl).host);
      expect((await chatWithEndpoint(ep(0), hi, 'u')).text).toBe('local model');
      expect(seen).toHaveLength(1);

      // A local model that is not running: the direct connection error says why.
      const closed = http.createServer();
      await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
      const closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/v1`;
      await new Promise((r) => closed.close(r));
      const down = await chatWithEndpoint(ep(0, closedUrl), hi, 'u').catch((e: Error) => e);
      expect(String(down)).toMatch(/无法连接接入点 本地模型: fetch failed（.*ECONNREFUSED.*）$/);
      expect(String(down)).not.toContain('系统代理');
    } finally {
      setGlobalDispatcher(new Agent());
      for (const s of servers) {
        s.closeAllConnections();
        s.close();
      }
    }
  });
});
