/** Minimal REST client for the TimeToPost public API. Never logs the token. */
export class CliError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
        this.name = 'CliError';
    }
}
export class Api {
    baseUrl;
    token;
    orgId;
    constructor(baseUrl, token, orgId) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.orgId = orgId;
    }
    async request(method, path, body) {
        const headers = { 'x-ttp-client': 'cli', Accept: 'application/json' };
        if (this.token)
            headers.Authorization = `Bearer ${this.token}`;
        if (this.orgId)
            headers['x-ttp-org'] = this.orgId;
        if (body !== undefined)
            headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        }
        catch (err) {
            throw new CliError(`Could not reach ${this.baseUrl} (${err.message}).`, 3);
        }
        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        }
        catch {
            data = text;
        }
        return { ok: res.ok, status: res.status, data };
    }
    /** Like request, but turns any non-2xx into a CliError with a readable message. */
    async call(method, path, body) {
        const r = await this.request(method, path, body);
        if (!r.ok)
            throw errorFromResponse(r);
        return r.data;
    }
    get(path) {
        return this.call('GET', path);
    }
    post(path, body) {
        return this.call('POST', path, body);
    }
    patch(path, body) {
        return this.call('PATCH', path, body);
    }
}
function extractMessage(data) {
    if (typeof data === 'string')
        return data.slice(0, 300);
    if (!data || typeof data !== 'object')
        return '';
    const parts = [];
    for (const k of ['message', 'error', 'error_description']) {
        if (typeof data[k] === 'string')
            parts.push(data[k]);
    }
    const issues = data.errors ?? data.details ?? data.issues;
    if (Array.isArray(issues)) {
        for (const i of issues.slice(0, 5)) {
            parts.push(typeof i === 'string' ? i : [i?.path?.join?.('.') ?? i?.field, i?.message].filter(Boolean).join(': '));
        }
    }
    return parts.filter(Boolean).join(' | ');
}
export function errorFromResponse(r) {
    const detail = extractMessage(r.data);
    switch (r.status) {
        case 401:
            return new CliError(`Not authenticated (401). Run \`timetopost login\` or set TTP_TOKEN.${detail ? ` Server said: ${detail}` : ''}`, 2);
        case 403:
            return new CliError(`Forbidden (403). This token may be draft-only or read-only; schedule/approve need the publish capability.${detail ? ` Server said: ${detail}` : ''}`, 2);
        case 404:
            return new CliError(`Not found (404).${detail ? ` ${detail}` : ''}`);
        case 429:
            return new CliError(`Rate limited (429). Try again shortly.${detail ? ` ${detail}` : ''}`);
        default:
            return new CliError(`Request failed (${r.status}).${detail ? ` ${detail}` : ''}`);
    }
}
