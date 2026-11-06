import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const env = (...names: string[]) => names.map((n) => process.env[n]).find((v) => v && v !== 'none');

export function proxyUrl(): string | undefined {
  return env(...PROXY_VARS);
}

/** undici rejects proxies without a scheme (proxy.corp:8080), which corporate settings often use. */
function normalizeProxyEnv() {
  for (const name of PROXY_VARS) {
    const v = process.env[name];
    if (v && v !== 'none' && !v.includes('://')) process.env[name] = `http://${v}`;
  }
}

/**
 * fetch() gives up after 5 minutes without response headers or between two body chunks. Slow models
 * exceed both (long prefill, long non-streamed thinking), and llm.ts enforces its own timeouts.
 */
const NO_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 };

/**
 * Routes outgoing fetch() (model APIs) through the proxy from the environment, honouring NO_PROXY.
 * Always installs the dispatcher, replacing Node's own NODE_USE_ENV_PROXY one, for NO_TIMEOUTS.
 */
export function setupProxy(): string | undefined {
  normalizeProxyEnv();
  const url = proxyUrl();
  const masked = url?.replace(/\/\/[^/@]+@/, '//***@');
  if (url && /^https?:\/\//i.test(url)) {
    try {
      setGlobalDispatcher(new EnvHttpProxyAgent(NO_TIMEOUTS));
      return url;
    } catch (e) {
      console.warn(`Ignoring unusable proxy ${masked}: ${(e as Error).message}`);
    }
  } else if (url) {
    console.warn(`Ignoring proxy ${masked}: model API calls only support http:// or https:// proxies`);
  }
  setGlobalDispatcher(new Agent(NO_TIMEOUTS));
  return undefined;
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
