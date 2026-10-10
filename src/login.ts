import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Api, CliError } from './api.js';

const b64url = (b: Buffer) => b.toString('base64url');

export interface BrowserLoginOptions {
  apiUrl: string;
  openBrowser: (url: string) => void | Promise<void>;
  print: (line: string) => void;
  timeoutMs?: number;
  /** When true, the URL is printed but no browser is launched. */
  noBrowser?: boolean;
}

/**
 * Loopback OAuth (RFC 8252) against the same authorization server the hosted MCP
 * uses: dynamic client registration, PKCE S256, consent in the browser, then a
 * code exchange that mints a normal personal API token (revocable in
 * Settings -> API).
 */
export async function browserLogin(opts: BrowserLoginOptions): Promise<string> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  let server: Server | undefined;
  try {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (e: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state) {
        // Stray or forged request: refuse it but keep waiting for the real callback.
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid state.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err || !code) {
        res.end('<h1>TimeToPost login failed</h1><p>You can close this tab and retry in the terminal.</p>');
        rejectCode(new CliError(err ? `Authorization was denied (${err}).` : 'Login callback carried no code.'));
      } else {
        res.end('<h1>TimeToPost CLI is connected</h1><p>You can close this tab and return to the terminal.</p>');
        resolveCode(code);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const api = new Api(opts.apiUrl, null);
    const reg = await api.request('POST', '/mcp/oauth/register', {
      client_name: 'TimeToPost CLI',
      redirect_uris: [redirectUri],
    });
    if (!reg.ok || typeof reg.data?.client_id !== 'string') {
      throw new CliError(
        `Could not start browser login (HTTP ${reg.status}). Use \`timetopost login --manual\` to paste an API token instead.`
      );
    }
    const clientId: string = reg.data.client_id;
    const authUrl =
      `${opts.apiUrl}/mcp/oauth/authorize?` +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();

    opts.print('Open this URL to authorize the CLI:');
    opts.print(authUrl);
    if (!opts.noBrowser) {
      try {
        await opts.openBrowser(authUrl);
      } catch {
        /* the URL is printed, the user can open it manually */
      }
    }
    opts.print('Waiting for authorization in the browser...');

    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new CliError('Timed out waiting for browser authorization.')), timeoutMs);
    });
    let code: string;
    try {
      code = await Promise.race([codePromise, timeout]);
    } finally {
      clearTimeout(timer);
    }

    const tok = await api.request('POST', '/mcp/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (!tok.ok || typeof tok.data?.access_token !== 'string') {
      throw new CliError(`Token exchange failed (HTTP ${tok.status}). Retry, or use \`timetopost login --manual\`.`);
    }
    return tok.data.access_token;
  } finally {
    server?.close();
    server?.closeAllConnections?.();
  }
}
