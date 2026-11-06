export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.endsWith('/auth/login')) window.dispatchEvent(new Event('rs-unauthorized'));
    throw new ApiError(res.status, data.error || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

/** Download through fetch so server-side errors (e.g. render failures) can be shown instead of a broken file. */
export async function download(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `下载失败 (${res.status})`);
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
