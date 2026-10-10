import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Api, CliError } from './api.js';
import {
  DEFAULT_API_URL,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  resolveToken,
  writeCredentials,
  type Env,
} from './config.js';
import { browserLogin } from './login.js';
import { resolveMedia } from './media.js';
import { parseAt } from './time.js';

export const VERSION = '0.1.0';

export interface Io {
  env: Env;
  out: (s: string) => void;
  err: (s: string) => void;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
  promptHidden: (question: string) => Promise<string>;
  openBrowser: (url: string) => void | Promise<void>;
}

const HELP = `timetopost ${VERSION}: command line for TimeToPost

Usage: timetopost <command> [options]

Commands:
  login                    Authorize this machine (browser) and store a token
  logout                   Delete the stored token
  whoami                   Show the authenticated user, org and token capabilities
  accounts                 List connected social accounts
  draft                    Create a draft post. Never publishes.
  schedule                 Schedule a post (new content, or an existing draft with --post)
  list [posts|drafts|approvals]
                           List posts (default), engine drafts, or pending approvals
  approve <id>             Approve a pending draft/approval id (human gate)

Global options:
  --json                   Machine-readable output
  --api-url <url>          API base (default ${DEFAULT_API_URL}, env TIMETOPOST_API_URL)
  --org <id>               Organization override (env TIMETOPOST_ORG_ID)
  -h, --help               Show help (also: timetopost <command> --help)
  -v, --version            Show version

Auth: env TTP_TOKEN (or TIMETOPOST_API_TOKEN) always wins over the stored login.

login:    --manual (paste an API token), --with-token (read token from stdin), --no-browser
draft:    --text <s> | --file <path> | stdin; --account <id|name> (repeatable),
          --platform <p> (repeatable), --collection <name>, --media <url|file> (repeatable),
          --brand <tag>
schedule: --at <iso> [--tz <IANA>]; either --post <draftPostId> or the draft options above
list:     --status <s>, --source <s> (approvals), --limit <n>
approve:  <id> [--at <iso> --tz <IANA>] [--account <id>]

Exit codes: 0 ok, 1 error, 2 auth/permission, 3 network, 64 usage.
`;

const OPTIONS = {
  json: { type: 'boolean' },
  'api-url': { type: 'string' },
  org: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  manual: { type: 'boolean' },
  'with-token': { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  text: { type: 'string' },
  file: { type: 'string' },
  account: { type: 'string', multiple: true },
  platform: { type: 'string', multiple: true },
  collection: { type: 'string' },
  media: { type: 'string', multiple: true },
  brand: { type: 'string' },
  at: { type: 'string' },
  tz: { type: 'string' },
  post: { type: 'string' },
  status: { type: 'string' },
  source: { type: 'string' },
  limit: { type: 'string' },
} as const;

class UsageError extends CliError {
  constructor(m: string) {
    super(m, 64);
  }
}

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

export async function run(argv: string[], io: Io): Promise<number> {
  let json = argv.includes('--json');
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    } catch (e) {
      throw new UsageError(`${(e as Error).message}. Run \`timetopost --help\`.`);
    }
    const { values: f, positionals } = parsed;
    json = !!f.json;
    const [cmd, ...rest] = positionals;
    if (f.version) {
      io.out(VERSION + '\n');
      return 0;
    }
    if (f.help || !cmd || cmd === 'help') {
      io.out(HELP);
      return 0;
    }

    const stored = await readCredentials(io.env);
    const apiUrl = (f['api-url'] || io.env.TIMETOPOST_API_URL || stored?.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    const orgId = f.org || io.env.TIMETOPOST_ORG_ID || undefined;
    const ctx: Ctx = { io, f, apiUrl, orgId, json, rest };

    switch (cmd) {
      case 'login':
        return await cmdLogin(ctx);
      case 'logout': {
        const removed = await deleteCredentials(io.env);
        io.out(removed ? 'Logged out (stored token deleted).\n' : 'No stored token.\n');
        return 0;
      }
      case 'whoami':
        return await cmdWhoami(ctx);
      case 'accounts':
        return await cmdAccounts(ctx);
      case 'draft':
        return await cmdDraft(ctx);
      case 'schedule':
        return await cmdSchedule(ctx);
      case 'list':
        return await cmdList(ctx);
      case 'approve':
        return await cmdApprove(ctx);
      default:
        throw new UsageError(`Unknown command "${cmd}". Run \`timetopost --help\`.`);
    }
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(`Unexpected error: ${(e as Error).message}`);
    io.err(json ? JSON.stringify({ error: err.message, exitCode: err.exitCode }) + '\n' : `Error: ${err.message}\n`);
    return err.exitCode;
  }
}

interface Ctx {
  io: Io;
  f: Flags;
  apiUrl: string;
  orgId?: string;
  json: boolean;
  rest: string[];
}

async function authedApi(c: Ctx): Promise<{ api: Api; source: string }> {
  const t = await resolveToken(c.io.env);
  if (!t) throw new CliError('Not logged in. Run `timetopost login` or set TTP_TOKEN.', 2);
  return { api: new Api(c.apiUrl, t.token, c.orgId), source: t.source };
}

function emit(c: Ctx, data: unknown, human: () => string) {
  c.io.out(c.json ? JSON.stringify(data, null, 2) + '\n' : human().replace(/\n?$/, '\n'));
}

function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')).join('\n');
}

const oneLine = (s: string, n = 60) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '...' : t;
};

// ---- login ---------------------------------------------------------------

async function cmdLogin(c: Ctx): Promise<number> {
  const { io, f, apiUrl } = c;
  let token = '';
  if (f['with-token']) {
    if (io.stdinIsTTY) throw new UsageError('--with-token reads the token from stdin. Pipe it in, e.g. `echo "$TOKEN" | timetopost login --with-token`.');
    token = (await io.readStdin()).trim();
  } else if (f.manual) {
    const appUrl = (io.env.TTP_APP_URL || 'https://timetopost.co').replace(/\/+$/, '');
    io.err(`Create an API token at ${appUrl}/dashboard/settings?tab=api and paste it below.\n`);
    token = (await io.promptHidden('API token (input hidden): ')).trim();
  } else {
    token = await browserLogin({
      apiUrl,
      openBrowser: io.openBrowser,
      print: (l) => io.err(l + '\n'),
      noBrowser: !!f['no-browser'],
    });
  }
  if (!token) throw new CliError('No token provided.');
  const me = await new Api(apiUrl, token, c.orgId).request('GET', '/api/auth/me');
  if (!me.ok) {
    throw new CliError(
      me.status === 401 ? 'That token was rejected by the API (401). Nothing was saved.' : `Could not verify token (HTTP ${me.status}). Nothing was saved.`,
      2
    );
  }
  const file = await writeCredentials(io.env, { token, apiUrl: apiUrl === DEFAULT_API_URL ? undefined : apiUrl });
  const who = me.data?.user?.email ?? me.data?.email;
  emit(c, { loggedIn: true, user: who ?? null, credentialsFile: file }, () => `Logged in${who ? ` as ${who}` : ''}. Token stored in ${file} (mode 600).`);
  if (io.env.TTP_TOKEN || io.env.TIMETOPOST_API_TOKEN) {
    io.err('Note: TTP_TOKEN / TIMETOPOST_API_TOKEN is set in this environment and takes precedence over the stored login.\n');
  }
  return 0;
}

// ---- whoami / accounts ---------------------------------------------------

async function cmdWhoami(c: Ctx): Promise<number> {
  const { api, source } = await authedApi(c);
  const data = await api.get('/api/auth/me');
  emit(c, { ...data, tokenSource: source }, () => {
    const u = data?.user ?? data ?? {};
    const lines: string[] = [];
    const add = (k: string, v: unknown) => {
      if (v !== undefined && v !== null && v !== '') lines.push(`${k.padEnd(13)}${typeof v === 'object' ? JSON.stringify(v) : v}`);
    };
    add('user', u.email ?? u.name);
    add('name', u.name);
    add('org', data?.org?.name ?? data?.organization?.name ?? data?.orgId ?? u.activeOrgId);
    add('capabilities', data?.capabilities ?? data?.token?.capabilities);
    add('canPublish', data?.canPublish);
    add('warning', data?.orgWarning ?? data?.warning);
    add('api', api.baseUrl);
    add('token from', source);
    return lines.join('\n');
  });
  return 0;
}

interface Account {
  id: string;
  provider: string;
  name: string;
  status: string;
  collection?: string;
}

async function fetchAccounts(api: Api): Promise<Account[]> {
  const data = await api.get('/api/integrations');
  const out: Account[] = [];
  for (const p of data?.integrations ?? []) {
    for (const a of p.accounts ?? []) {
      out.push({
        id: a.id,
        provider: p.provider,
        name: a.displayName || a.accountName || a.accountId || '',
        status: a.status,
        collection: a.collectionName ?? a.groupName ?? undefined,
      });
    }
  }
  return out;
}

async function cmdAccounts(c: Ctx): Promise<number> {
  const { api } = await authedApi(c);
  const accounts = await fetchAccounts(api);
  emit(c, { accounts }, () =>
    accounts.length === 0
      ? 'No connected accounts. Connect one at https://timetopost.co/dashboard/settings?tab=integrations'
      : table([['ID', 'PROVIDER', 'STATUS', 'NAME', 'COLLECTION'], ...accounts.map((a) => [a.id, a.provider, a.status ?? '', a.name, a.collection ?? ''])])
  );
  return 0;
}

// ---- draft / schedule ------------------------------------------------------

async function readContent(c: Ctx): Promise<string> {
  const { f, io } = c;
  const sources = [f.text !== undefined, f.file !== undefined].filter(Boolean).length;
  if (sources > 1) throw new UsageError('Use only one of --text and --file.');
  let text: string;
  if (f.text !== undefined) text = f.text;
  else if (f.file !== undefined) {
    try {
      text = f.file === '-' ? await io.readStdin() : await readFile(f.file, 'utf8');
    } catch {
      throw new CliError(`Could not read file: ${f.file}`);
    }
  } else if (!io.stdinIsTTY) text = await io.readStdin();
  else throw new UsageError('No content. Pass --text, --file, or pipe text on stdin.');
  text = text.replace(/\s+$/, '');
  if (!text) throw new UsageError('Content is empty.');
  return text;
}

async function buildPostBody(c: Ctx, api: Api): Promise<Record<string, unknown>> {
  const { f } = c;
  const content = await readContent(c);
  const body: Record<string, unknown> = { content };
  const wanted = f.account ?? [];
  const platforms = new Set<string>(f.platform ?? []);
  if (wanted.length > 0) {
    const accounts = await fetchAccounts(api);
    const ids: string[] = [];
    for (const w of wanted) {
      const byId = accounts.filter((a) => a.id === w);
      const matches = byId.length ? byId : accounts.filter((a) => a.name.toLowerCase() === w.toLowerCase());
      if (matches.length === 0) throw new CliError(`No connected account matches "${w}". Run \`timetopost accounts\`.`);
      if (matches.length > 1) throw new CliError(`"${w}" matches several accounts (${matches.map((m) => `${m.provider}:${m.id}`).join(', ')}). Use the id.`);
      ids.push(matches[0].id);
      platforms.add(matches[0].provider);
    }
    body.accountIds = ids;
  }
  if (f.collection) body.collection = f.collection;
  if (platforms.size > 0) body.platforms = [...platforms];
  if (!body.platforms && !body.collection) {
    throw new UsageError('Choose a target with --account, --platform or --collection.');
  }
  if (f.brand) body.brand = f.brand;
  if (f.media?.length) body.mediaUrls = await resolveMedia(api, f.media, (m) => c.io.err(m + '\n'));
  return body;
}

const postSummary = (p: any) => `${p?.id ?? '?'}  status=${p?.status ?? '?'}${p?.scheduledAt ? `  scheduledAt=${p.scheduledAt}` : ''}`;

async function cmdDraft(c: Ctx): Promise<number> {
  if (c.f.at) throw new UsageError('`draft` never schedules. Use `timetopost schedule --at ...`.');
  const { api } = await authedApi(c);
  const body = await buildPostBody(c, api);
  const data = await api.post('/api/posts', body);
  const post = data?.post ?? data;
  const status = String(post?.status ?? '').toLowerCase();
  if (status !== 'draft') {
    throw new CliError(`Safety check failed: the API returned status "${status || 'none'}" for a draft request (post ${post?.id}). Review it in the dashboard.`);
  }
  emit(c, data, () => `Draft created: ${postSummary(post)}\nIt will not publish until you schedule or approve it.`);
  return 0;
}

async function cmdSchedule(c: Ctx): Promise<number> {
  if (!c.f.at) throw new UsageError('`schedule` needs --at <ISO time>.');
  const at = parseAt(c.f.at, c.f.tz);
  const { api } = await authedApi(c);
  let data: any;
  if (c.f.post) {
    data = await api.patch(`/api/posts/${encodeURIComponent(c.f.post)}`, { scheduledAt: at });
  } else {
    const body = await buildPostBody(c, api);
    body.scheduledAt = at;
    data = await api.post('/api/posts', body);
  }
  const post = data?.post ?? data;
  emit(c, data, () => `Scheduled: ${postSummary({ ...post, scheduledAt: post?.scheduledAt ?? at })}`);
  return 0;
}

// ---- list ------------------------------------------------------------------

async function cmdList(c: Ctx): Promise<number> {
  const kind = c.rest[0] ?? 'posts';
  const { api } = await authedApi(c);
  const limit = c.f.limit ? Number(c.f.limit) : 25;
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer.');
  if (kind === 'posts') {
    const data = await api.get('/api/posts');
    let posts: any[] = data?.posts ?? [];
    if (c.f.status) posts = posts.filter((p) => String(p.status).toLowerCase() === c.f.status!.toLowerCase());
    if (c.f.platform?.length) posts = posts.filter((p) => (p.platforms ?? []).some((x: string) => c.f.platform!.includes(x)));
    posts = posts.slice(0, limit);
    emit(c, { posts }, () =>
      posts.length === 0 ? 'No posts.' : table([['ID', 'STATUS', 'WHEN', 'PLATFORMS', 'CONTENT'], ...posts.map((p) => [p.id, p.status, p.scheduledAt ?? p.createdAt ?? '', (p.platforms ?? []).join(','), oneLine(p.content)])])
    );
    return 0;
  }
  if (kind === 'drafts') {
    const qs = c.f.status ? `?status=${encodeURIComponent(c.f.status.toUpperCase())}` : '';
    const data = await api.get(`/api/drafts${qs}`);
    const drafts: any[] = (data?.drafts ?? []).slice(0, limit);
    emit(c, { drafts }, () =>
      drafts.length === 0 ? 'No drafts.' : table([['ID', 'STATUS', 'PLATFORM', 'CONTENT'], ...drafts.map((d) => [d.id, d.status, d.platform ?? '', oneLine(Array.isArray(d.segments) ? d.segments[0] : d.preview ?? '')])])
    );
    return 0;
  }
  if (kind === 'approvals') {
    const q = new URLSearchParams();
    if (c.f.status) q.set('status', c.f.status);
    if (c.f.source) q.set('source', c.f.source);
    const data = await api.get(`/api/drafts/approvals${q.toString() ? `?${q}` : ''}`);
    const items: any[] = (data?.items ?? data?.approvals ?? []).slice(0, limit);
    emit(c, data && !Array.isArray(data) ? { ...data, items } : { items }, () =>
      items.length === 0 ? 'Nothing awaiting approval.' : table([['ID', 'SOURCE', 'STATUS', 'PREVIEW'], ...items.map((i) => [i.id, i.source ?? '', i.status ?? '', oneLine(i.title ? `${i.title}: ${i.preview ?? ''}` : i.preview ?? '')])])
    );
    return 0;
  }
  throw new UsageError(`Unknown list kind "${kind}". Use posts, drafts or approvals.`);
}

// ---- approve ---------------------------------------------------------------

async function cmdApprove(c: Ctx): Promise<number> {
  const id = c.rest[0];
  if (!id) throw new UsageError('Usage: timetopost approve <id>');
  const { api } = await authedApi(c);
  const body: Record<string, unknown> = {};
  if (c.f.at) body.scheduledFor = parseAt(c.f.at, c.f.tz);
  if (c.f.account?.length) body.accountIds = c.f.account;

  // Prefer the per-item action the approvals rail advertises (covers trend drafts etc).
  let path = `/api/drafts/${encodeURIComponent(id)}/approve`;
  const rail = await api.request('GET', '/api/drafts/approvals');
  if (rail.ok) {
    const item = (rail.data?.items ?? rail.data?.approvals ?? []).find((i: any) => i.id === id);
    const action = item?.actions?.find((a: any) => a.key === 'approve');
    if (action && action.method === 'POST' && typeof action.path === 'string' && action.path.startsWith('/api/') && !action.path.includes('..')) {
      path = action.path;
    }
  }
  const data = await api.post(path, body);
  emit(c, data, () => {
    const post = data?.post ?? data;
    const when = post?.scheduledAt ?? data?.scheduledAt;
    return `Approved ${id}${post?.id && post.id !== id ? ` (post ${post.id})` : ''}${when ? `, scheduled for ${when}` : ''}.`;
  });
  return 0;
}
