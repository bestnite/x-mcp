# How x-mcp finds X's GraphQL operations

This server is read-only and unofficial: it calls the same internal API the X web app calls.
Two things have to be rediscovered whenever X ships a front-end build — which operation id
sits behind each read, and which variables that operation expects. This document records how
that discovery works now, what it looked like before, and how to repair it.

Kept method-first on purpose. It describes the anchor points in X's markup and the rules for
walking them, not X's code; recorded assets stay out of git (see [Hygiene](#7-hygiene)).

---

## 0. What changed in November 2026

Two independent mechanisms broke in the same deploy, and both are worth knowing because the
old one may come back:

| | Until 2026-10 | Since 2026-11 |
|---|---|---|
| Operation ids | mined from the webpack module table in `main.js` (~104 entries) | embedded in the SSR document of the page that needs the data |
| Request signing | `x-client-transaction-id` header, mandatory (no header → HTTP 404) | not required at all (with or without → HTTP 200) |
| Response shapes | `legacy.*` carried text and counts | `details.*`, `counts.*`, `media_entities2`, `reply_to_results` |

The break is visible from the outside: `x.com/home` no longer references any `main.js`; it
loads `https://abs.twimg.com/x-web/x-web/entry-client-<hash>.js`. The old signer chain
(`entry-client` → `startup-dynamic`/`client-transaction-id-plugin` → `sign.o-*`) no longer
exists, so `ClientTransaction.initialize()` failed with *"Couldn't find the sign module
importer"* — that was the 404-free but total outage the server had before this rewrite.

Measured on 2026-11-17, same cookies, same query id:

```
GET /i/api/graphql/<id>/SearchByRawQuery  with x-client-transaction-id    → 200
GET /i/api/graphql/<id>/SearchByRawQuery  without it                      → 200
GET /i/api/2/timeline/home.json                                          → 200
GET /i/api/1.1/trends/place.json?id=1                                    → 200
```

## 1. Where an operation lives now

`x-web` server-renders the data a page needs, and the serialized document carries the relay
operation that produced it. Two record formats appear, both in the same documents:

```
A.  id:"<queryId>",name:"<OperationName>",variables:{ <JS object literal> }        ← search / profile pages
B.  key:"<queryId>{<JSON>}",name:"<OperationName>"                                ← status / profile pages
```

Format A gives the variables as a JavaScript literal (bare keys, `!0`/`!1`, `void 0`,
occasional `$R[n]` back-references). Format B gives them as JSON *inside* a JS string, so
every inner quote is escaped and the payload ends at the first unescaped `"`.

Which page hides which operation, as of this build:

| Page | Operations found | Format |
|---|---|---|
| `GET /search?q=<q>&src=typed_query&f=live` | `SearchByRawQuery` | A |
| `GET /<handle>` | `UserByScreenName`, `UserOriginalsTimeline` | A / B |
| `GET /i/web/status/<id>` | `TweetDetail`, `TweetResultByRestId` | B |

`https://x.com/i/web/status/<id>` is deliberately used instead of `/<handle>/status/<id>`:
it carries the same records without needing to know whose post it is. The homepage does
**not** carry any of the six reads (its records are `viewerQuery`, `sidebarPaymentsQuery`,
`pinnedTimelinesQuery`), which is why discovery is per-page rather than per-session.

## 2. Reading the payload without a JS engine

- **Braces must be scanned, not searched.** Variable templates contain URLs and quoted text;
  slicing from the first `{` to the first `}` cuts the object in half. Walk the string,
  tracking string quotes and escapes, and stop at the balancing brace.
- **Format A needs a literal repair pass** before `JSON.parse`: `!0`/`!1` → `true`/`false`,
  `void 0` → `null`, bare keys → quoted keys. A `$R[n]` reference points at another slot in
  the same document and cannot be resolved locally — degrade it to `null` rather than
  abandoning the operation; relay switches never use it.
- **Format B needs the escaped-string boundary.** From the `{` after the query id, scan to the
  first quote that is not preceded by a backslash, then unescape `\"` and `JSON.parse`.
- **The name must be adjacent.** Format B records and relay *result* records share the
  `key:"…{…}"` shape; the result form is
  `key:"<queryId>{…}",result:$R[n]={kind:"Result.Ok",value:"…"}` with no `name`, so requiring
  `,name:"<Op>"` immediately after the string is what tells them apart.

## 3. The variable template is not optional

Each record ships the exact variable object the page sent, including a batch of
`__relay_internal__pv__*` switches. X validates them: dropping one answers

```
422 {"errors":[{"code":"GRAPHQL_VALIDATION_FAILED","message":"must be defined",
     "path":["variable","__relay_internal__pv__xclientsfeaturesappviewercansendmoneyrelayprovider"]}]}
```

So the call spreads the template first and overrides only the keys the caller owns
(`screenName`, `rawQuery`, `focalTweetId`, `count`, `cursor`, `product`). Two consequences:

- The template is per operation, not per caller — caching by operation name is correct even
  when two users are looked up in a row.
- A 422 on a freshly discovered operation almost always means the *variable names* changed
  (`screen_name` → `screenName`, `userId` → `screenName`, …), not that the query id expired.

## 4. Failure taxonomy

| Observation | Meaning | Who can fix it |
|---|---|---|
| 401 / 403 on the page or the API | cookies dead or `ct0` mismatched | the user (new cookies) |
| page serves `entry-client-logged-out` | signed-out page for these cookies | the user (new cookies) |
| page has no record for the operation | x-web stopped shipping it / renamed it | a maintainer |
| 404 / 422 from the API, twice | query id or variables changed | a maintainer |
| 404 on a profile/status page | that account or post does not exist | the caller (wrong id) |
| 429 | rate limit | wait |

`404` and `422` are therefore never fatal on the first attempt: the client rediscovers the
operation from the same page and retries exactly once. Anything else is reported as-is.

## 5. Maintenance playbook

| Symptom | Most likely cause | Where to look |
|---|---|---|
| `… no longer embeds the <Op> operation` | the page stopped shipping it, or the record format changed | `FORMAT_A` / `FORMAT_B` in `src/x/operations.ts`, and the page table above |
| `422 … "must be defined", path:["variable","__relay_internal__pv__…"]` | the page template was not reused | the spread in `src/x/client.ts` `attemptGraphql` |
| `422 … "must be defined", path:["variable","screenName"]` | variable renamed | compare the page literal with the call site in `src/x/api.ts` |
| Posts come back with empty text / zero counts | field locations moved again | the field table in [endpoints.md](endpoints.md) §3 |
| Timeline is empty but HTTP 200 | the `data` root moved (it did once: `user_result_by_screen_name…`) | the roots table in [endpoints.md](endpoints.md) §2 |
| Signed-out page for cookies that were working an hour ago | they really did expire | ask the user for new ones |

Debugging route: `XClient.graphql` is the single funnel, so a one-off script that calls it
prints both the discovered operation and the raw response. `scripts/mcp-smoke.mjs` exercises
all six tools end to end against a live server.

## 6. Retired: `x-client-transaction-id` (2026-10 → 2026-11)

The header was a 94-character base64 blob, mandatory for every GraphQL call, derived per
request from four inputs: a 48-byte verification key from
`meta[name="twitter-site-verification"]`, four animation frames scraped from
`<svg id="loading-x-anim-N">`, byte indices mined out of the minified signer, and the request's
own method and path. The payload was `key || timeNow(4, LE) || sha256(...)[0..16] || 0x03`,
XOR-masked with a leading random byte, then base64 with padding stripped. `src/tid/` (483
lines plus a recorded fixture harness) implemented it and matched X's own signer byte for byte.

It is recorded here because the deciding evidence was empirical, and the same evidence may
have to be re-gathered if X ever reintroduces signing:

- the header was required: identical request without it returned 404, not 401/403;
- re-recording fixtures against a frozen clock was the only way to prove equivalence;
- every failure mode looked identical (404 for "no header", "stale query id" and "retired
  operation"), which is why the old code retried with a rebuilt signer before blaming the
  endpoint.

Two things killed it: the build that carries the signer stopped being served (`sign.o-*`
gone from the asset chain), and requests without the header started succeeding. Deleting the
signer removed 643 lines of code and one permanent maintenance burden, and the server now
depends on nothing that has to be re-derived numerically.

If it comes back: `git log -- src/tid` has the implementation, this section has the layout
and the traps (rounding semantics differ per field, `substring(9)` is positional, `h`/`s`
command numbers are data, base64 not base64url).

## 7. Hygiene

- Recorded assets (`home.html`, `*.js`) are **X Corp.'s code**. They are gitignored and never
  committed; only synthetic fixtures shaped like the real documents live in `test/`.
- The discovery path is not a security boundary and does not bypass authentication — it reads
  pages and endpoints the account owner's own browser session can read.
- Respect X's terms and rate limits; this is for personal, read-only access.
