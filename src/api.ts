/** Minimal REST client for the TimeToPost public API. Never logs the token. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

export class Api {
  constructor(
    readonly baseUrl: string,
    private readonly token: string | null,
    private readonly orgId?: string
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { 'x-ttp-client': 'cli', Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.orgId) headers['x-ttp-org'] = this.orgId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CliError(`Could not reach ${this.baseUrl} (${(err as Error).message}).`, 3);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  }

  /** Like request, but turns any non-2xx into a CliError with a readable message. */
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request<T>(method, path, body);
    if (!r.ok) throw errorFromResponse(r);
    return r.data;
  }
  get<T = any>(path: string) {
    return this.call<T>('GET', path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.call<T>('POST', path, body);
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.call<T>('PATCH', path, body);
  }
}

function extractMessage(data: any): string {
  if (typeof data === 'string') return data.slice(0, 300);
  if (!data || typeof data !== 'object') return '';
  const parts: string[] = [];
  for (const k of ['message', 'error', 'error_description']) {
    if (typeof data[k] === 'string') parts.push(data[k]);
  }
  const issues = data.errors ?? data.details ?? data.issues;
  if (Array.isArray(issues)) {
    for (const i of issues.slice(0, 5)) {
      parts.push(typeof i === 'string' ? i : [i?.path?.join?.('.') ?? i?.field, i?.message].filter(Boolean).join(': '));
    }
  }
  return parts.filter(Boolean).join(' | ');
}

export function errorFromResponse(r: ApiResponse): CliError {
  const detail = extractMessage(r.data);
  switch (r.status) {
    case 401:
      return new CliError(
        `Not authenticated (401). Run \`timetopost login\` or set TTP_TOKEN.${detail ? ` Server said: ${detail}` : ''}`,
        2
      );
    case 403:
      return new CliError(
        `Forbidden (403). This token may be draft-only or read-only; schedule/approve need the publish capability.${detail ? ` Server said: ${detail}` : ''}`,
        2
      );
    case 404:
      return new CliError(`Not found (404).${detail ? ` ${detail}` : ''}`);
    case 429:
      return new CliError(`Rate limited (429). Try again shortly.${detail ? ` ${detail}` : ''}`);
    default:
      return new CliError(`Request failed (${r.status}).${detail ? ` ${detail}` : ''}`);
  }
}
