import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Agent, setGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { chromeProxy, proxyUrl, setupProxy } from '../src/proxy.js';

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
});
