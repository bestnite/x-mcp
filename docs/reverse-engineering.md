# Reverse-engineering `x-client-transaction-id`

This document records **how** the transaction-id generator in `src/tid/` was derived, not
just what it computes. The goal is that the next person — or the next version of us —
can repair it when X changes its frontend without starting over.

Kept method-first on purpose: it describes the asset chain, the regular expressions, the
numeric pipeline and the verification trick. It does **not** paste X's JavaScript; the
recorded assets are gitignored (see [Hygiene](#9-hygiene-and-legal)).

---

## 0. What the output looks like

| Property | Value | How it is known |
|---|---|---|
| Header length | 94 base64 characters | measured on a live 200 response |
| Payload before base64 | 70 bytes | 1 + 48 + 4 + 16 + 1 |
| Verification key | 48 bytes | base64-decoded `meta[twitter-site-verification]` |
| Base64 flavour | standard, padding stripped | payload contains `+` and `/`, trailing `=` removed |

The 70 bytes and the 94 characters corroborate each other, which is a useful sanity check
when touching the layout: if the length changes, the layout changed.

## 1. Proof that the header is mandatory

Before reverse-engineering anything, establish the failure mode. With a valid
`auth_token` + `ct0` cookie and every other header in place:

```
GET /i/api/graphql/<queryId>/SearchTimeline  with x-client-transaction-id  -> HTTP 200
GET /i/api/graphql/<queryId>/SearchTimeline  without it                     -> HTTP 404
```

A 404 — not a 401, not a 403 — is what X returns for a request it refuses to even route.
Two consequences:

- The cookie alone is not sufficient; signing is a hard gate.
- A 404 from this API is ambiguous. Absence of a transaction id, a stale `queryId`, and a
  retired operation all look identical. Disambiguate by re-sending with a known-good
  transaction id before blaming the endpoint.

Legacy v1.1 endpoints (`/i/api/1.1/account/settings.json`, `verify_credentials.json`) answer
`{"code":34}` and cannot be used to validate a session. GraphQL only.

## 2. Finding the code that produces it

The signer is not in one file. X loads it through a chain, and the chain is discoverable
from the homepage alone:

```
https://x.com/home
  └─ <script> pointing at  …/entry-client-<hash>.js          (absolute URL, abs.twimg.com)
       └─ "./assets/startup-dynamic-<hash>.js"               (or client-transaction-id-plugin-*)
            └─ "./sign.o-<hash>.js"                          (the signer itself)
```

Each hop is a regex over the previous response:

| Hop | Pattern (simplified) |
|---|---|
| homepage → entry | `["'](https://abs\.twimg\.com/[^"']+/entry-client[\w-]*\.js)["']` |
| entry → importer | `["']([./\w-]*(?:client-transaction-id-plugin\|startup-dynamic)-[\w-]+\.js)["']` |
| importer → signer | `["'`]([./\w-]*sign\.o-[\w-]+\.js)["'`]` |

Two lessons worth keeping:

- **Resolve relative to the URL that contained the reference**, not to a fixed base. The
  entry script lives at `/x-web/x-web/`, the importer at `/x-web/x-web/assets/`.
- **Do not hardcode the asset paths.** They are content-hashed and change frequently;
  the file names in this repository's recordings are already obsolete.

The signer is one of at least two chunk names (`ondemand.s` historically, `sign.o` now).
Implementations that only look for `ondemand.s` break silently on the newer layout.

## 3. The three inputs

**a. Verification key** — `meta[name="twitter-site-verification"]`, `content` attribute,
base64. Decoded it is 48 bytes. Match the *meta tag* and then extract `content`; the
attribute order is not stable, so a single regex over the whole tag is fragile.

**b. Animation frames** — the homepage carries four elements
`<svg id="loading-x-anim-N"><g><path …/><path d="M 10,30 C …"/></g></svg>`. The **second**
`<path>` of each is the animation data; the first is the X logo.

**c. Key-byte indices** — from the signer source, a run of repeated expressions of the form
`(e[27], 16)`, `(e[4], 16)`, … The first index is the *row selector*, the rest multiply
into the *frame time*.

```
indices = /\(\w{1}\[(\d{1,2})\],\s*16\)+/g   →  [27, 4, 16, 41]   (current shape)
rowIndex         = indices[0]
keyBytesIndices  = indices[1:]
```
An empty match set means the signer was rewritten — fail loudly, do not fall back.

## 4. Deriving the animation key

Given the frame row `frames` (a flat array of integers parsed from the path data):

```
frameRowIndex = keyBytes[5] % 16                      // note: 5, not rowIndex
frameTime     = jsRound( Π (keyBytes[i] % 16) / 10 ) * 10
targetTime    = frameTime / 4096
```

Parsing the path data has three non-obvious steps:

1. `d.substring(9)` strips the leading `M 10,30 C`.
2. Split on `'C'` — each segment is one cubic.
3. **Every** digit run in a segment becomes a number, including the numbers behind `h`
   and `s` commands. They are not ignored; they are swallowed into the row as extra
   values. Filtering them out shifts every subsequent column and breaks the result.

Then the frame is interpreted as a CSS-like keyframe:

| Field | From | Range mapping |
|---|---|---|
| fromColor | frames[0..2] + `1.0` | 0–255 |
| toColor | frames[3..5] + `1.0` | 0–255 |
| fromRotation | `0.0` | — |
| toRotation | frames[6] | `solve(60, 360, floor)` |
| curves | frames[7..] | `solve(isOdd(i) ? -1 : 0, 1, round2)` |

`solve(v, min, max, floor) = v * (max - min) / 255 + min`.

The curve array feeds a cubic-bezier solver that binary-searches until
`|t - x(s)| < 1e-5`. **Keep that epsilon.** A "better" tolerance changes which `t` the
colour and matrix are sampled at.

Finally the key is the concatenation of:

- three colour channels as `Math.round(c).toString(16)` (lowercase, no zero padding),
- four matrix values from `convertRotationToMatrix`, each `roundTo2 → abs → floatToHex`,
  where a leading `.` (values < 1) is prefixed with `0` and lowercased, while values ≥ 1
  keep uppercase `A–F`,
- the literal `"0"`, `"0"`,
- with all `.` and `-` characters finally removed.

## 5. Assembling the transaction id

```
timeNow  = floor((now_ms - 1682924400 * 1000) / 1000)     // epoch 2023-05-01T07:00:00Z
payload  = keyBytes (48) || timeNow (4, little-endian) || sha256(input)[0..16] || 0x03
tid      = base64( randomByte || (payload XOR randomByte) )  // strip '='
```

```
sha256 input = `${method}!${path}!${timeNow}${keyword}${animationKey}`
keyword      = "obfiowerehiring"      // fixed suffix
appended byte= 3                      // fixed, not random
```

`method` and `path` are the ones of the **request being signed** — `GET` and
`/i/api/graphql/<queryId>/<OperationName>`. The same generator therefore has to be
consulted per request, not once per session.

The leading random byte is what makes two ids for the same request differ. That is by
design; it also dictates how to compare them (see below).

## 6. Ground truth instead of guessing

The decisive technique: **run X's own signer in a real browser against a frozen clock and
record its output**, then make our implementation reproduce those bytes offline.

The recording procedure (originally performed for QuaX with a real Chrome instance):

1. Load `x.com/home` and let the real site boot.
2. Resolve the same asset chain, then execute the signer chunk inside the page.
3. Call its export with a fixed `now` and a chosen `(method, path)`.
4. Persist: the homepage HTML, every asset along the chain, the URL→file index, and the
   produced id for each case.

What that buys us: a deterministic fixture. `test/fixtures/XClientTransactionId/` holds two
cases — `GET …/SearchTimeline` and `POST …/FavoriteTweet` — with `nowMs` pinned. Our test
replays the recorded files through `fetchSources()` and asserts equality.

**Comparing ids requires removing the randomness first:**

```
payloadOf(id) = bytes(id)[1..]  each XOR'd with bytes(id)[0]
```

Two ids for the same request are only comparable after that step. Comparing raw strings
would fail on every run.

This is the difference between "looks plausible" and "is equivalent": the recorded cases
are the only evidence that the numeric pipeline matches, and they caught every rounding
and case-sensitivity trap below.

**Our own verification, for the record** (2026-10-23): with the ported generator,
`initialize` against the live site took ~2.1 s, produced a 94-character id, and
`GET SearchTimeline` returned HTTP 200 with 5 tweets.

## 7. Maintenance playbook

| Symptom | Most likely cause | Where to look |
|---|---|---|
| `ClientTransactionIdError: Couldn't find the entry script` | homepage markup changed / bot-walled | `ENTRY_SCRIPT_REGEX`, and whether a 200 was even returned |
| `Couldn't find the sign module importer` | chunk naming changed (`startup-dynamic` → ?) | `SIGN_IMPORTER_REGEX` |
| `Couldn't find the sign module` | signer renamed (e.g. back to `ondemand.s`) | `SIGN_FILE_REGEX` |
| `Couldn't get KEY_BYTE indices` | signer minified differently | `INDICES_REGEX` |
| `Couldn't find the loading-x-anim frames` | animation markup moved into JS-rendered DOM | `get2dArray` |
| Requests now 404 **with** a transaction id | algorithm changed | re-record fixtures, then diff the numeric stages |
| `SourceFetchError` | network/503 | not a signing issue; retry |

When re-recording, compare against the **old** recording first. If payloads for the old
cases still match, the algorithm is intact and the failure is environmental.

## 8. Traps

Collected the hard way; each one produces a valid-looking 94-character string that X rejects.

- **Rounding semantics differ per field.** `jsRound` is JS `Math.round` (half toward +∞,
  so `-2.5 → -2`); `roundTo2` is Dart's `round()` (half away from zero). Dart's native
  `round()` and Python's banker's rounding both disagree with JS on halves.
- **`floatToHex` must stay a greedy loop.** `Number.prototype.toString(16)` decides its own
  precision and casing; the algorithm depends on the exact digit count this loop emits.
- **Case is not uniform.** Colour channels are lowercase; matrix hex is uppercase; only
  the `0`-prefixed (sub-1) matrix values get lowercased.
- **No zero padding.** `Math.round(9).toString(16)` is `"9"`, not `"09"`.
- **`substring(9)` is positional**, not semantic. If the path prefix ever changes length,
  this silently eats real data.
- **`h`/`s` command numbers are data.** Do not filter them out as "non-curve" values.
- **`keyBytes[5]` selects the frame**, while `keyBytes[rowIndex]` selects the row. They are
  easy to swap and still produce output.
- **Little-endian, 4 bytes, signed shift.** `(timeNow >> (i*8)) & 0xff` — use `Math.floor`
  not `>>>` guards; in JS the shift is signed 32-bit, so mask after shifting.
- **Base64, not base64url.** `+` and `/` are expected; only `=` is stripped.
- **The trailing `0x03` is a constant**, not the random byte.

## 9. Hygiene and legal

- Recorded assets (`home.html`, `*.js`) are **X Corp.'s code**. They are gitignored and
  never committed. Only `expected.json` (ids we derived) and `sources.json` (a URL index)
  are tracked.
- Code in this repository is a **port** of prior MIT-licensed implementations, verified
  against observed behaviour of X's own signer. Attribution chain is declared in each file
  header: iSarabjitDhiman/XClientTransaction (Python) → Teskann/QuaX (Dart) → this project.
  It is not a clean-room rewrite, and the MIT notices travel with it.
- The signer is obfuscation for anti-automation, not a security boundary. Nothing here
  bypasses authentication: it signs requests made with the account owner's own cookie.
  Respect X's terms and rate limits; this is for personal, read-only access.
