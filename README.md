English | [简体中文](docs/README.zh.md)

# x-mcp

A read-only MCP server for X (Twitter). It exposes profiles, posts, search, trends and
conversations as MCP tools, using the same API the X web app calls — no developer account,
no API key, no HTML scraping.

## Tools

| Tool | Description |
|---|---|
| `x_auth_status` | Check whether the configured session still works |
| `x_user_lookup` | Profile by handle: bio, follower and post counts, verification, join date, avatar, banner |
| `x_user_tweets` | A user's recent posts, newest first; retweets include the original post |
| `x_home_timeline` | The authenticated account's "For you" feed |
| `x_search` | Search posts, with X operators such as `from:`, `lang:`, `min_faves:` and `#tag` |
| `x_tweet_detail` | A post with its reply conversation; supports paging |
| `x_trends` | Trending topics by location |

All tools are read-only. Posting, liking, bookmarking and direct messages are out of scope.

## Requirements

- Node.js 20 or later
- An X account with a browser session

## Installation

### From npm

```bash
npx -y @nite07/x-mcp
```

### From the private registry

The same package is mirrored to a self-hosted Gitea registry. Both flags are required: the
package comes from Gitea, its dependencies from npmjs.

```bash
npx -y --registry=https://registry.npmjs.org/ \
  --@nite07:registry=https://git.nite07.com/api/packages/nite/npm/ \
  @nite07/x-mcp
```

### From source

```bash
git clone https://git.nite07.com/nite/x-mcp.git
cd x-mcp
npm install
npm run build
node dist/stdio.js
```

## Configuration

The server authenticates with your existing X browser session. Two cookies are needed:
`auth_token` and `ct0`.

1. Sign in to <https://x.com> in a browser.
2. Open DevTools → Application → Cookies → `x.com`.
3. Copy the values of `auth_token` and `ct0`.

Provide them in whichever form matches how the server is started.

**Environment variables**, when a client launches the process:

```
X_AUTH_TOKEN=<auth_token>
X_CSRF_TOKEN=<ct0>
X_LANG=zh-cn
```

`X_LANG` is optional and affects the language of X's responses.

**`.env` file**, when running from source in the project directory:

```
auth_token=<auth_token>
ct0=<ct0>
lang=zh-cn
```

These values are a complete login state. Treat them as a password: keep the file at mode
`600` and never commit it.

## Client setup

Most MCP clients accept a JSON server definition:

```json
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "@nite07/x-mcp@latest"],
      "env": {
        "X_AUTH_TOKEN": "<auth_token>",
        "X_CSRF_TOKEN": "<ct0>"
      }
    }
  }
}
```

The server communicates over stdio. It can also run as a standalone HTTP endpoint if your
client prefers that transport:

```bash
npm start
# POST http://127.0.0.1:8787/mcp
```

## Usage

Check the session before relying on the data tools:

```
x_auth_status  {}
```

Look up a profile, then its recent posts:

```
x_user_lookup   {"username": "X"}
x_user_tweets   {"username": "X", "limit": 20}
```

Search with X operators:

```
x_search  {"query": "from:X lang:en", "product": "Latest", "limit": 20}
```

Read a conversation, one page at a time:

```
x_tweet_detail  {"id": "2106019976381689871", "limit": 40}
                → { "tweet": {...}, "replies": [...], "nextCursor": "DAAKCgABHVQ…" }

x_tweet_detail  {"id": "2106019976381689871", "limit": 40, "cursor": "DAAKCgABHVQ…"}
                → { "tweet": null, "replies": [...], "nextCursor": "..." }
```

Paged responses contain only replies; `tweet` is `null` on those pages. Continue while
`nextCursor` is present. Each page's size is decided by X, so `limit` caps how many items are
returned rather than requesting more from the server.

## Troubleshooting

| Symptom | Action |
|---|---|
| `[err.auth_expired]` or `[err.auth_csrf]` | The session cookies are no longer valid. Copy both `auth_token` and `ct0` again from a signed-in browser, update them, and restart the client. |
| `[err.auth_restricted]` | The account is locked, suspended, or not permitted to read the target. Resolve it on x.com; new cookies will not help. |
| `[err.rate_limited]` | Wait until the time given in the message. |
| `[err.query_stale]` or `[err.signer_broken]` | X changed its frontend and the server needs an update. See the developer documentation below. |
| `[err.not_found]` | The handle or post id does not exist, or is not visible to this account. |
| `[err.upstream]` | Transient. Retry once. |

Every error states whether retrying can help, so a client driving these tools can decide
without guessing.

## Limitations

- **Read-only.** No posting, liking, bookmarking or direct messages.
- **Unofficial API.** X can change it at any time. The server refreshes request identifiers
  and rebuilds its request signer automatically, but a breaking change on X's side may still
  require an update.
- **Rate limits follow your account.** Heavy automated use may be throttled or flagged by X.
- **Personal use.** Use your own account and stay within X's terms of service.

## Developer documentation

- [docs/endpoints.md](docs/endpoints.md) — which endpoint serves what, and how X's response
  shapes differ between versions
- [docs/reverse-engineering.md](docs/reverse-engineering.md) — how the request signing header
  was derived, the maintenance playbook, and the traps

## License

MIT

## Disclaimer

Not affiliated with, endorsed by, or sponsored by X Corp. X and Twitter are trademarks of
X Corp. This software is provided as is, for personal use, and you are responsible for
complying with X's terms of service.
