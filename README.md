# timetopost

Command line for [TimeToPost](https://timetopost.co). Log in, see your connected
accounts, create drafts, schedule posts and approve drafts from a terminal or a script.

```bash
npx timetopost --help
# or
npm i -g timetopost
```

Requires Node 18+. No runtime dependencies.

## Log in

```bash
timetopost login                 # opens your browser, authorizes via OAuth (PKCE, loopback)
timetopost login --no-browser    # print the URL instead of opening it
timetopost login --manual        # paste an API token (input hidden)
echo "$TOKEN" | timetopost login --with-token
```

`login` mints a normal personal API token (visible and revocable in
Settings > API) and stores it in `~/.config/timetopost/credentials.json`
(mode 600). The token is verified against the API before anything is saved and is
never printed.

For CI and scripts set `TTP_TOKEN` (or `TIMETOPOST_API_TOKEN`). Precedence:
`TTP_TOKEN` > `TIMETOPOST_API_TOKEN` > stored login.

## Commands

```bash
timetopost whoami                       # user, org, token capabilities, canPublish
timetopost accounts                     # connected social accounts (ids, providers, collections)

# Drafts never publish.
timetopost draft --text "Shipping the CLI today" --account Acme
echo "long post" | timetopost draft --platform twitter --platform linkedin
timetopost draft --file post.md --account int_abc --media ./shot.png

# Scheduling queues a real post (needs a token with the publish capability).
timetopost schedule --post <draftPostId> --at 2026-11-02T09:30 --tz Europe/Madrid
timetopost schedule --text "Launch" --account int_abc --at 2026-11-02T09:30:00+01:00

timetopost list                         # posts
timetopost list --status draft --limit 10
timetopost list drafts --status pending # engine drafts awaiting approval
timetopost list approvals --json        # unified approvals rail

timetopost approve <id>                 # human gate: approve + schedule
timetopost approve <id> --at 2026-11-02T09:30Z
```

Targets: `--account` takes a connected account id or its exact name (repeatable),
`--platform` takes a provider key (repeatable), `--collection` a collection name.
`--media` takes an http(s) URL or a local image/video file (uploaded for you).

`--at` accepts an ISO 8601 time. With `Z` or an offset it is used as is; a bare
local time is read in `--tz` (IANA name) or your machine's timezone. Times in the
past are rejected before any request is made.

## Global options

| Option | Meaning |
| --- | --- |
| `--json` | Print raw API JSON (errors go to stderr as JSON) |
| `--api-url <url>` | API base, default `https://api.timetopost.co` (env `TIMETOPOST_API_URL`) |
| `--org <id>` | Organization override sent as `x-ttp-org` (env `TIMETOPOST_ORG_ID`) |
| `-h, --help` / `-v, --version` | |

## Exit codes

`0` ok, `1` error, `2` not authenticated or not permitted (401/403), `3` network
failure, `64` usage error.

## Safety

- `draft` never sends a schedule time and aborts if the API ever reports a
  non-draft status.
- A draft-only token can create drafts but gets a 403 on `schedule` and `approve`;
  the CLI reports that plainly.
- Make sure `whoami` shows the organization you intend before scheduling.

## Development

```bash
npm install
npm run build
npm test        # builds, then runs node:test against a local mock server
```

MIT licensed.
