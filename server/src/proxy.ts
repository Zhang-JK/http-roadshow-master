import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const env = (...names: string[]) => names.map((n) => process.env[n]).find((v) => v && v !== 'none');

export function proxyUrl(): string | undefined {
  return env('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy');
}

/** fetch() honours HTTP(S)_PROXY by itself only with NODE_USE_ENV_PROXY=1 on Node 22.21+ / 24.5+. */
function nativeEnvProxy(): boolean {
  if (process.env.NODE_USE_ENV_PROXY !== '1') return false;
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

/** Routes outgoing fetch() (model APIs) through the proxy from the environment, honouring NO_PROXY. */
export function setupProxy(): string | undefined {
  const url = proxyUrl();
  if (url && !nativeEnvProxy()) setGlobalDispatcher(new EnvHttpProxyAgent());
  return url;
}

/** Proxy settings for headless Chrome, or undefined when no proxy is configured. */
export function chromeProxy(): { server: string; bypass?: string; username?: string; password?: string } | undefined {
  const url = proxyUrl();
  if (!url) return undefined;
  try {
    const u = new URL(url.includes('://') ? url : `http://${url}`);
    return {
      server: `${u.protocol}//${u.host}`,
      bypass: env('NO_PROXY', 'no_proxy'),
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return undefined;
  }
}
