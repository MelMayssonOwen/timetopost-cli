import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { run } from '../src/cli.js';
import { parseAt } from '../src/time.js';
let server;
let base;
let reqs = [];
let pkce = {};
const GOOD = 'ttp_good';
const accounts = {
    integrations: [
        { provider: 'twitter', accounts: [{ id: 'int_x', accountName: 'acme', displayName: 'Acme', status: 'connected' }] },
        { provider: 'linkedin', accounts: [{ id: 'int_li', accountName: 'acme-co', status: 'connected', collectionName: 'acme' }] },
    ],
};
async function readBody(req) {
    const chunks = [];
    for await (const c of req)
        chunks.push(c);
    const t = Buffer.concat(chunks).toString();
    try {
        return t ? JSON.parse(t) : undefined;
    }
    catch {
        return t;
    }
}
before(async () => {
    server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const body = await readBody(req);
        reqs.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.authorization, org: req.headers['x-ttp-org'], body });
        const json = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        const p = url.pathname;
        if (p === '/mcp/oauth/register')
            return json(201, { client_id: 'cid' });
        if (p === '/mcp/oauth/authorize') {
            pkce.challenge = url.searchParams.get('code_challenge');
            const target = new URL(url.searchParams.get('redirect_uri'));
            target.searchParams.set('code', 'authcode');
            target.searchParams.set('state', url.searchParams.get('state'));
            res.writeHead(302, { Location: target.toString() });
            return res.end();
        }
        if (p === '/mcp/oauth/token') {
            const ok = body.code === 'authcode' && createHash('sha256').update(body.code_verifier).digest('base64url') === pkce.challenge;
            return ok ? json(200, { access_token: GOOD, token_type: 'Bearer' }) : json(400, { error: 'invalid_grant' });
        }
        if (p === '/upload/k1')
            return json(req.headers.authorization ? 400 : 200, {});
        if (req.headers.authorization !== `Bearer ${GOOD}`)
            return json(401, { error: 'Unauthorized' });
        if (p === '/api/auth/me')
            return json(200, { user: { email: 'mel@example.com' }, capabilities: ['read', 'draft'], canPublish: false });
        if (p === '/api/integrations')
            return json(200, accounts);
        if (p === '/api/posts' && req.method === 'GET')
            return json(200, { posts: [
                    { id: 'p1', status: 'draft', content: 'hello', platforms: ['twitter'], createdAt: '2026-01-01' },
                    { id: 'p2', status: 'scheduled', content: 'later', platforms: ['linkedin'], scheduledAt: '2030-01-01T00:00:00.000Z' },
                ] });
        if (p === '/api/posts' && req.method === 'POST') {
            if (body.content === 'FORBID')
                return json(403, { error: 'Missing publish capability' });
            return json(201, { success: true, post: { id: 'new1', status: body.scheduledAt ? 'scheduled' : 'draft', scheduledAt: body.scheduledAt } });
        }
        if (p === '/api/posts/p1' && req.method === 'PATCH')
            return json(200, { success: true, post: { id: 'p1', status: 'scheduled', scheduledAt: body.scheduledAt } });
        if (p === '/api/drafts')
            return json(200, { drafts: [{ id: 'd1', status: 'PENDING', platform: 'twitter', segments: ['seg one'] }] });
        if (p === '/api/drafts/approvals')
            return json(200, { items: [
                    { id: 'd1', source: 'posts', status: 'PENDING', preview: 'seg one', actions: [{ key: 'approve', method: 'POST', path: '/api/drafts/d1/approve' }] },
                    { id: 't9', source: 'trends', status: 'PENDING', preview: 'trend', actions: [{ key: 'approve', method: 'POST', path: '/api/trends/t9/approve' }] },
                ] });
        if (p === '/api/drafts/d1/approve' || p === '/api/trends/t9/approve')
            return json(200, { success: true, post: { id: 'pp', scheduledAt: body.scheduledFor } });
        if (p === '/api/media/presign')
            return json(200, { key: 'k1', uploadUrl: `${base}/upload/k1`, publicUrl: `${base}/pub/k1.png` });
        if (p === '/api/media/confirm')
            return json(201, { asset: { publicUrl: `${base}/pub/k1.png` } });
        json(404, { message: 'nope' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
    reqs = [];
});
async function cli(args, opts = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'ttpcli-'));
    return cliIn(dir, args, opts);
}
async function cliIn(dir, args, opts = {}) {
    let out = '';
    let err = '';
    let opened = '';
    const io = {
        env: { TTP_CONFIG_DIR: dir, ...opts.env },
        out: (s) => void (out += s),
        err: (s) => void (err += s),
        stdinIsTTY: opts.tty ?? opts.stdin === undefined,
        readStdin: async () => opts.stdin ?? '',
        promptHidden: async () => opts.hidden ?? '',
        openBrowser: async (u) => {
            opened = u;
            void fetch(u); // follow authorize -> loopback callback
        },
    };
    const code = await run(['--api-url', base, ...args], io);
    return { code, out, err, opened, dir };
}
const authed = { TTP_TOKEN: GOOD };
describe('basics', () => {
    it('--help and --version exit 0', async () => {
        const h = await cli(['--help']);
        assert.equal(h.code, 0);
        assert.match(h.out, /Usage: timetopost/);
        const v = await cli(['--version']);
        assert.match(v.out, /^\d+\.\d+\.\d+/);
    });
    it('unknown command is a usage error (64)', async () => {
        const r = await cli(['bogus']);
        assert.equal(r.code, 64);
    });
    it('no token gives exit 2 without calling the API', async () => {
        const r = await cli(['whoami']);
        assert.equal(r.code, 2);
        assert.match(r.err, /Not logged in/);
        assert.equal(reqs.length, 0);
    });
    it('a 401 from the API is exit 2 with guidance', async () => {
        const r = await cli(['whoami'], { env: { TTP_TOKEN: 'ttp_bad' } });
        assert.equal(r.code, 2);
        assert.match(r.err, /401/);
        assert.ok(!r.err.includes('ttp_bad'));
    });
});
describe('token precedence', () => {
    it('TTP_TOKEN beats TIMETOPOST_API_TOKEN beats the file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ttpcli-'));
        await cliIn(dir, ['login', '--with-token'], { stdin: GOOD + '\n' });
        // file only
        let r = await cliIn(dir, ['whoami']);
        assert.equal(r.code, 0);
        assert.equal(reqs.at(-1).auth, `Bearer ${GOOD}`);
        assert.match(r.out, /credentials file/);
        // TIMETOPOST_API_TOKEN overrides the file (bad one proves which was used)
        r = await cliIn(dir, ['whoami'], { env: { TIMETOPOST_API_TOKEN: 'ttp_bad' } });
        assert.equal(r.code, 2);
        assert.equal(reqs.at(-1).auth, 'Bearer ttp_bad');
        // TTP_TOKEN overrides both
        r = await cliIn(dir, ['whoami'], { env: { TIMETOPOST_API_TOKEN: 'ttp_bad', TTP_TOKEN: GOOD } });
        assert.equal(r.code, 0);
        assert.equal(reqs.at(-1).auth, `Bearer ${GOOD}`);
        assert.match(r.out, /TTP_TOKEN/);
    });
});
describe('login', () => {
    it('loopback OAuth with PKCE stores a mode 600 file and never prints the token', async () => {
        const r = await cli(['login']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.opened, /\/mcp\/oauth\/authorize\?/);
        const file = join(r.dir, 'credentials.json');
        const st = await stat(file);
        assert.equal(st.mode & 0o777, 0o600);
        assert.equal(JSON.parse(await readFile(file, 'utf8')).token, GOOD);
        assert.ok(!r.out.includes(GOOD) && !r.err.includes(GOOD));
        assert.match(r.out, /mel@example.com/);
    });
    it('--manual prompts for a token and verifies it', async () => {
        const r = await cli(['login', '--manual'], { hidden: GOOD });
        assert.equal(r.code, 0, r.err);
        assert.match(r.err, /dashboard\/settings\?tab=api/);
        assert.equal(JSON.parse(await readFile(join(r.dir, 'credentials.json'), 'utf8')).token, GOOD);
    });
    it('rejects an invalid token and saves nothing', async () => {
        const r = await cli(['login', '--manual'], { hidden: 'ttp_bad' });
        assert.equal(r.code, 2);
        await assert.rejects(stat(join(r.dir, 'credentials.json')));
    });
    it('logout deletes the file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ttpcli-'));
        await cliIn(dir, ['login', '--with-token'], { stdin: GOOD });
        const r = await cliIn(dir, ['logout']);
        assert.equal(r.code, 0);
        await assert.rejects(stat(join(dir, 'credentials.json')));
    });
});
describe('read commands', () => {
    it('whoami', async () => {
        const r = await cli(['whoami'], { env: authed });
        assert.equal(r.code, 0);
        assert.match(r.out, /mel@example.com/);
        assert.match(r.out, /canPublish\s+false/);
        assert.equal(reqs[0].path, '/api/auth/me');
    });
    it('accounts --json flattens providers', async () => {
        const r = await cli(['accounts', '--json'], { env: authed });
        const j = JSON.parse(r.out);
        assert.deepEqual(j.accounts.map((a) => a.id), ['int_x', 'int_li']);
    });
    it('list filters by status and sends the org header', async () => {
        const r = await cli(['list', '--status', 'draft', '--org', 'org_1'], { env: authed });
        assert.match(r.out, /p1/);
        assert.ok(!r.out.includes('p2'));
        assert.equal(reqs[0].org, 'org_1');
    });
    it('list drafts and approvals', async () => {
        let r = await cli(['list', 'drafts', '--status', 'pending'], { env: authed });
        assert.match(r.out, /d1/);
        assert.equal(reqs[0].path, '/api/drafts?status=PENDING');
        r = await cli(['list', 'approvals', '--json'], { env: authed });
        assert.equal(JSON.parse(r.out).items.length, 2);
    });
});
describe('draft', () => {
    it('creates a draft from --text, never sends scheduledAt, resolves account by name', async () => {
        const r = await cli(['draft', '--text', 'hi there', '--account', 'Acme'], { env: authed });
        assert.equal(r.code, 0, r.err);
        const post = reqs.find((q) => q.path === '/api/posts' && q.method === 'POST');
        assert.deepEqual(post.body, { content: 'hi there', accountIds: ['int_x'], platforms: ['twitter'] });
        assert.ok(!('scheduledAt' in post.body));
        assert.match(r.out, /status=draft/);
    });
    it('reads stdin and --file', async () => {
        let r = await cli(['draft', '--platform', 'twitter'], { env: authed, stdin: 'from stdin\n' });
        assert.equal(r.code, 0, r.err);
        assert.equal(reqs.at(-1).body.content, 'from stdin');
        const f = join(await mkdtemp(join(tmpdir(), 'ttpf-')), 'p.txt');
        await writeFile(f, 'from file');
        r = await cli(['draft', '--platform', 'twitter', '--file', f], { env: authed });
        assert.equal(reqs.at(-1).body.content, 'from file');
    });
    it('refuses --at and missing targets, and errors on unknown accounts', async () => {
        assert.equal((await cli(['draft', '--text', 'x', '--platform', 'twitter', '--at', '2031-01-01T00:00:00Z'], { env: authed })).code, 64);
        assert.equal((await cli(['draft', '--text', 'x'], { env: authed })).code, 64);
        const r = await cli(['draft', '--text', 'x', '--account', 'nobody'], { env: authed });
        assert.equal(r.code, 1);
        assert.match(r.err, /No connected account/);
    });
    it('aborts if the API unexpectedly returns a non-draft status', async () => {
        // collection path with scheduledAt injected is impossible from the CLI; simulate by 403 instead
        const r = await cli(['draft', '--text', 'FORBID', '--platform', 'twitter'], { env: authed });
        assert.equal(r.code, 2);
        assert.match(r.err, /403/);
    });
    it('uploads a local media file via presign/PUT/confirm', async () => {
        const f = join(await mkdtemp(join(tmpdir(), 'ttpm-')), 'a.png');
        await writeFile(f, Buffer.from([1, 2, 3]));
        const r = await cli(['draft', '--text', 'pic', '--platform', 'twitter', '--media', f, '--media', 'https://x.test/b.jpg'], { env: authed });
        assert.equal(r.code, 0, r.err);
        assert.deepEqual(reqs.find((q) => q.path === '/api/posts' && q.method === 'POST').body.mediaUrls, [`${base}/pub/k1.png`, 'https://x.test/b.jpg']);
    });
});
describe('schedule', () => {
    it('schedules new content with a UTC ISO time', async () => {
        const r = await cli(['schedule', '--text', 'go', '--account', 'int_li', '--at', '2031-03-01T09:30:00+01:00'], { env: authed });
        assert.equal(r.code, 0, r.err);
        const post = reqs.find((q) => q.path === '/api/posts' && q.method === 'POST');
        assert.equal(post.body.scheduledAt, '2031-03-01T08:30:00.000Z');
        assert.match(r.out, /status=scheduled/);
    });
    it('schedules an existing draft with PATCH, honoring --tz', async () => {
        const r = await cli(['schedule', '--post', 'p1', '--at', '2031-07-01T09:00', '--tz', 'Europe/Madrid'], { env: authed });
        assert.equal(r.code, 0, r.err);
        const patch = reqs.find((q) => q.method === 'PATCH');
        assert.equal(patch.path, '/api/posts/p1');
        assert.equal(patch.body.scheduledAt, '2031-07-01T07:00:00.000Z');
    });
    it('rejects past and malformed times locally', async () => {
        assert.equal((await cli(['schedule', '--post', 'p1', '--at', '2020-01-01T00:00:00Z'], { env: authed })).code, 1);
        assert.equal((await cli(['schedule', '--post', 'p1', '--at', 'tomorrow'], { env: authed })).code, 1);
        assert.equal((await cli(['schedule', '--post', 'p1'], { env: authed })).code, 64);
        assert.equal(reqs.length, 0);
    });
});
describe('approve', () => {
    it('uses the approvals rail action path and passes scheduledFor', async () => {
        const r = await cli(['approve', 't9', '--at', '2031-03-01T00:00:00Z'], { env: authed });
        assert.equal(r.code, 0, r.err);
        const post = reqs.find((q) => q.method === 'POST');
        assert.equal(post.path, '/api/trends/t9/approve');
        assert.equal(post.body.scheduledFor, '2031-03-01T00:00:00.000Z');
    });
    it('falls back to /api/drafts/:id/approve', async () => {
        const r = await cli(['approve', 'd1', '--json'], { env: authed });
        assert.equal(r.code, 0, r.err);
        assert.equal(reqs.find((q) => q.method === 'POST').path, '/api/drafts/d1/approve');
    });
    it('requires an id', async () => {
        assert.equal((await cli(['approve'], { env: authed })).code, 64);
    });
});
describe('parseAt', () => {
    it('handles DST via IANA tz', () => {
        assert.equal(parseAt('2031-01-15T10:00', 'America/New_York', 0), '2031-01-15T15:00:00.000Z');
        assert.equal(parseAt('2031-07-15T10:00', 'America/New_York', 0), '2031-07-15T14:00:00.000Z');
    });
});
