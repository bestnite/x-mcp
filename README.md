# x-mcp

A read-only MCP server for X (formerly Twitter), built on X's **internal GraphQL API** —
the one the web app itself calls. No paid developer API, no HTML scraping, no Nitter.

Credentials are the account owner's own browser session (`auth_token` + `ct0`).

## Tools

| Tool | What it returns |
|---|---|
| `x_auth_status` | whether the stored session still works; says who has to fix it when it does not |
| `x_user_lookup` | profile by handle: bio, follower/following/post counts, verification, join date, avatar & banner |
| `x_user_tweets` | a user's recent posts, retweets nested |
| `x_home_timeline` | the authenticated account's "For you" feed |
| `x_search` | post search with X operators (`from:`, `lang:`, `min_faves:`, …), Latest/Top/Media |
| `x_tweet_detail` | one post plus its reply conversation |
| `x_trends` | trending topics by `woeid` (1 = worldwide, 23424781 = mainland China) |

Every tool is read-only. Writes (post, like, bookmark) are deliberately absent: clients like
QuaX and Squawker keep those local-only, so there is no verified reference implementation to
follow.

## Error semantics

The caller is an agent, so every failure answers three questions: what happened, who can
fix it, and whether retrying helps.

```
[err.auth_expired] x.com redirected /home to /i/jf/onboarding/web?… — the session cookies are no longer valid.

Meaning: The stored X session cookie is no longer accepted. X does not refresh auth_token
         in responses, so this cannot self-heal.
Action:  Ask the user to: log in to x.com in a browser, open DevTools → Application →
         Cookies → x.com, copy auth_token and ct0, replace both values in the server's .env,
         then restart the server.
Retryable: no — do not call this tool again until the action above is done
```

| Code | Who can fix it |
|---|---|
| `auth_missing`, `auth_expired`, `auth_csrf` | the user — refresh cookies, restart the server |
| `auth_restricted` | the user — unlock or appeal on x.com; new cookies will not help |
| `rate_limited` | nobody — wait for the reset time in the message |
| `query_stale`, `signer_broken` | a maintainer — X changed its frontend (see the docs) |
| `not_found` | nobody — the handle or post id is wrong |
| `upstream` | retry once, then report |

None of these are guesses about intent: `auth_*` means a retry is guaranteed to fail,
`upstream` means it might succeed.

**A trap worth knowing:** X answers an invalid cookie with a **307 to a login page**, not a
401. Following that redirect yields a `200` login page, which looks exactly like "the page
layout changed". So the server checks status codes before parsing, and when preparation
(queryId extraction or signer build) fails, it probes the session first and attributes the
failure to auth if that is the real cause.

`x_auth_status` is the cheap way to ask the same question on purpose: it requests
`x.com/home` with the stored cookies and reports the redirect, without building the signer.

## Status

| Part | State |
|---|---|
| `src/tid/` — `x-client-transaction-id` signer | ✅ byte-for-byte verified against recorded fixtures |
| `src/x/` — GraphQL + legacy REST client, queryId auto-discovery | ✅ all six read endpoints verified live (2026-10-23) |
| `src/mcp/` — MCP tools over streamable HTTP | ✅ seven tools, end-to-end smoke test passes |
| Tests | ✅ 30 unit tests, no network required |

## Quick start

```bash
npm install
cp .env.example .env        # then fill in auth_token / ct0
npm run build
npm start                   # HTTP entrypoint, listens on 127.0.0.1:8787/mcp
```

```bash
npm test                    # unit tests (offline)
node scripts/mcp-smoke.mjs  # end-to-end, needs a running server + valid cookie
```

Health check: `curl http://127.0.0.1:8787/health` → `{ status, operations, tools }`.

### Install from a registry

The package is published to the self-hosted Gitea registry as `@nite/x-mcp`. Only the
scoped package goes through Gitea; its dependencies still resolve from npmjs:

```bash
npx -y --registry=https://registry.npmjs.org/ \
  --@nite:registry=https://git.nite07.com/api/packages/nite/npm/ \
  @nite/x-mcp
```

That command is what an MCP host runs — it starts the stdio entrypoint (`dist/stdio.js`).
Everything logged goes to stderr, so the JSON-RPC stream stays clean.

Credentials come from the environment in that mode:

```
X_AUTH_TOKEN=...
X_CSRF_TOKEN=...
X_LANG=zh-cn
```

### Configuration

`.env` (mode 600, gitignored):

```
auth_token=...
ct0=...
twid=u%3D...
lang=zh-cn
X_MCP_HOST=127.0.0.1
X_MCP_PORT=8787
```

Extract the cookies from a logged-in browser: devtools → Application → Cookies → `x.com`.
Password login through the API is closed (`code 366`) and guest mode is closed; the cookie is
the only path. It is a full login state — treat it as a password.

### MCP endpoint

Streamable HTTP, **stateless**, JSON responses: `POST http://127.0.0.1:8787/mcp`.
Drop it behind a gateway if several clients should share one server.

## How it survives X changing things

Three things expire on X's schedule, and each has its own recovery path:

| Dependency | Lifetime | Failure | Handling |
|---|---|---|---|
| cookie | until revoked | 401 / 403 | surfaced as an auth error, no retry |
| `queryId` + feature flags | ~22 days | 404 / 422 | re-extracted from `main.js`, retried once |
| transaction-id signer | when the frontend changes | 404 | signer rebuilt from a fresh x.com fetch, retried once |

queryIds are **never hardcoded**. `main.js` currently exposes ~104 operations as
`{queryId, operationName, featureSwitches, fieldToggles}`; the registry parses all of them at
startup (or on demand) and caches them for 6 hours.

Two of the six endpoints are not GraphQL at all — X no longer serves a `HomeTimeline`
operation, and trends still live on v1.1. See
**[docs/endpoints.md](docs/endpoints.md)** for what was found, how, and the 2026 shape changes.

## Layout

```
src/
  tid/        transaction-id signer (see docs/reverse-engineering.md)
  x/          client.ts, operations.ts, parse.ts, api.ts, auth.ts
  mcp/        tool definitions
  config.ts   .env loading
  index.ts    HTTP entrypoint
docs/
  reverse-engineering.md   how the signing header was reverse-engineered + traps
  endpoints.md             which operation serves what, and the 2026 shape changes
test/         30 unit tests (fixtures for the signer, synthetic payloads for parsers)
scripts/      mcp-smoke.mjs — end-to-end check against a running server
```

### Fixtures

`test/fixtures/XClientTransactionId/` needs the recorded snapshot (`home.html`, `*.js`)
next to `expected.json`. Those files are X Corp.'s code and are gitignored; `expected.json`
and `sources.json` are tracked. Without the assets the fixture suite skips itself.
Recording steps are in the reverse-engineering doc, §6.

## Attribution

The signer is a reimplementation from observed behaviour, following prior MIT-licensed
ports: [iSarabjitDhiman/XClientTransaction](https://github.com/iSarabjitDhiman/XClientTransaction)
(Python) → [Teskann/QuaX](https://github.com/Teskann/QuaX) (Dart) → this project.

Not affiliated with X Corp. For personal, read-only use; respect X's terms and rate limits.

## License

MIT (to be finalized before publishing).
