# x-mcp

A read-only MCP server for X (formerly Twitter), built on X's **internal GraphQL API** —
the one the web app itself calls. No paid developer API, no scraping HTML, no Nitter.

Credentials are the account owner's own browser session (`auth_token` + `ct0`).

## Status

| Part | State |
|---|---|
| `src/tid/` — `x-client-transaction-id` signer | ✅ done, byte-for-byte verified against recorded fixtures |
| GraphQL client (queryId discovery, 6 read endpoints) | ⏳ not started |
| MCP layer (streamable HTTP, MCPHub) | ⏳ not started |

## Why a self-maintained signer

Every request must carry an `x-client-transaction-id` header computed from X's own web
frontend. There is an npm implementation, but it only understands the `ondemand.s` chunk
and is a single-maintainer dependency at the one point where breakage is guaranteed.

This repository vendors ~650 lines instead, so the failure is ours to see and ours to fix,
and so it can be regression-tested offline against bytes produced by X's real signer.

The derivation is documented in **[docs/reverse-engineering.md](docs/reverse-engineering.md)** —
asset chain, regexes, the numeric pipeline, the verification trick, the maintenance
playbook, and the list of traps that produce plausible-looking but rejected ids.

## Install and test

```bash
npm install
npm test          # 16 cases, incl. 2 golden fixtures compared byte-for-byte
npx tsc -p . --noEmit
```

### Fixtures

`test/fixtures/XClientTransactionId/` needs the recorded snapshot (`home.html`, `*.js`)
next to `expected.json`. Those files are X Corp.'s code and are gitignored; `expected.json`
and `sources.json` are tracked. Without the assets the fixture suite skips itself.

Recording steps are described in the reverse-engineering doc, §6.

## Layout

```
src/tid/
  transaction.ts   fetch chain, animation-frame parsing, id assembly
  constants.ts     regexes and browser headers
  utils.ts         jsRound / roundTo2 / isOdd / floatToHex / payloadOf
  cubic.ts         cubic-bezier solver
  interpolate.ts   linear interpolation
  rotation.ts      rotation -> 2x2 matrix
  errors.ts        ClientTransactionIdError vs SourceFetchError
test/
  tid.math.test.ts     numeric primitives
  tid.fixture.test.ts  golden fixtures + error classification
```

`sources.json` lists every URL the generator must fetch; if it asks for a URL absent from
that index, the asset chain changed and the regexes need updating.

## Credentials

Put the session in `.env` (mode 600, gitignored):

```
auth_token=...
ct0=...
twid=u%3D...
lang=zh-cn
```

Extract from a logged-in browser: devtools → Application → Cookies → `x.com`. Password
login through the API is closed (`code 366`) and guest mode is closed; the cookie is the
only path. It is a full login state — treat it as a password.

## Attribution

The signer is a reimplementation from observed behaviour, following prior MIT-licensed
ports: [iSarabjitDhiman/XClientTransaction](https://github.com/iSarabjitDhiman/XClientTransaction)
(Python) → [Teskann/QuaX](https://github.com/Teskann/QuaX) (Dart) → this project.

Not affiliated with X Corp. For personal, read-only use; respect X's terms and rate limits.

## License

MIT (to be finalized before publishing).
