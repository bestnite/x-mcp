# Read endpoints: what they are, and how they were found

Companion to [reverse-engineering.md](reverse-engineering.md). That file covers *discovery* —
how the server learns an operation's query id and variables from a page. This one covers
*routing*: which operation or REST path serves each read capability, and what the response
actually looks like.

Everything below was re-verified against a live account on **2026-11-17**, after X replaced
its front end with the `x-web` build.

## The six capabilities

| MCP tool | Transport | Target | `data` root |
|---|---|---|---|
| `x_user_lookup` | GraphQL | `UserByScreenName` (`screenName`) | `user_result_by_screen_name.result` |
| `x_user_tweets` | GraphQL | `UserOriginalsTimeline` (`screenName`, `count`, `cursor`) | `user_result_by_screen_name.result.profile_user_originals_timeline.timeline.instructions` |
| `x_home_timeline` | **REST v2** | `/i/api/2/timeline/home.json` | — (`globalObjects`) |
| `x_search` | GraphQL | `SearchByRawQuery` (`rawQuery`, `count`, `cursor`, `product`) | `search_by_raw_query.search_timeline.timeline.instructions` |
| `x_tweet_detail` | GraphQL | `TweetDetail` (`focalTweetId`, `cursor`, `withFocalTweet`) | `threaded_conversation_with_injections_v2.instructions` |
| `x_trends` | **REST v1.1** | `/i/api/1.1/trends/place.json?id=<woeid>` | — (array) |

Query ids are never hardcoded — they come from the page that needs the data, at runtime (see
`src/x/operations.ts` and reverse-engineering.md §1). No request needs a signature header any
more.

Two naming traps in this table:

- `SearchTimeline` (the 2025 operation) is gone; the web app now calls `SearchByRawQuery`.
- `UserTweets` is gone too: asking that name returns
  `422 GRAPHQL_VALIDATION_FAILED {"message":"Internal server error"}`. The profile page's
  timeline is `UserOriginalsTimeline`, and it takes **`screenName`**, not `userId` — which is
  why a numeric user id is resolved through `GET /i/user/<id>` (a 302 to `/<handle>`) first.

## Finding 1: `HomeTimeline` still does not exist as an operation

Unchanged from 2025: no operation named `HomeTimeline`/`HomeLatestTimeline`/anything similar
exists in the current build. What works is the pre-GraphQL v2 REST endpoint:

```
GET /i/api/2/timeline/home.json?count=20&tweet_mode=full
→ 200, { globalObjects: { tweets, users, … }, timeline: { instructions } }
```

Two quirks of that envelope:

- `timeline.instructions[0]` is `{ addEntries: { entries } }` — **no `type` field**, unlike
  GraphQL timelines.
- Each entry's post id sits at `content.item.content.tweet.id` (three levels), and the post
  body lives separately in `globalObjects.tweets`. `full_text` is often an empty string even
  with `tweet_mode=full`, so fall back to `text` with `||`, not `??`.

It does **not** require a transaction id (it never did).

## Finding 2: most of v1.1 is dead, but trends survived

`/i/api/1.1/account/settings.json` and `verify_credentials.json` return `{"code":34}` (page
does not exist). The trends endpoint is untouched:

```
GET /i/api/1.1/trends/place.json?id=1   → 200, 50 trends
GET /i/api/1.1/guide/trends.json?id=1   → 404 code 34
```

An endpoint being "v1.1" says nothing about whether it is alive — check per path, not per
version.

## Finding 3: the post object moved (2026-11)

The 2025 note "posts still use `legacy`" is no longer true. `legacy` now carries four keys
(`conversation_id_str`, `entities`, `lang`, and occasionally `possibly_sensitive`), and

| Field | 2025 shape | 2026 shape |
|---|---|---|
| body | `legacy.full_text` | `details.full_text` (long posts: `note_tweet.note_tweet_results.result.text`) |
| created at | `legacy.created_at` (string) | `details.created_at_ms` (epoch millis) |
| likes / reposts / replies / quotes | `legacy.favorite_count`, … | `counts.favorite_count`, `.retweet_count`, `.reply_count`, `.quote_count` |
| views | `views.count` | `views.count` — still a **string** (`"1"`) |
| media | `legacy.extended_entities.media` | `media_entities2` (same item shape, video info included) |
| reply target | `legacy.in_reply_to_status_id_str` | `reply_to_results.rest_id`, handle at `reply_to_user_results.result.core.screen_name` |
| quoted post | `quoted_status_result.result` | `quoted_tweet_results.result` |
| author | `core.user_results.result` | unchanged |

`src/x/parse.ts` reads the new location first and keeps the old one as a fallback, so a mixed
or half-rolled-back build still parses.

## Finding 4: the user object (2026-11)

Statistics live at the top level; `legacy` is nearly empty:

| Field | 2025 shape | 2026 shape |
|---|---|---|
| handle / name | `legacy.screen_name`, `legacy.name` | `core.screen_name`, `core.name` |
| joined | `legacy.created_at` (string) | `core.created_at_ms` (epoch millis) |
| followers / following | `legacy.followers_count`, `legacy.friends_count` | `relationship_counts.followers` / `.following` |
| post count | `legacy.statuses_count` | `tweet_counts.tweets` |
| bio | `legacy.description` | `profile_bio.description` |
| website | `legacy.entities.url.urls[0]` | `profile_bio.entities.description.urls[0].expanded_url` |
| avatar / banner | `legacy.profile_image_url_https`, `legacy.profile_banner_url` | `avatar.image_url`, `banner.image_url` |
| likes given | `legacy.favourites_count` | `action_counts.favorites_count` |
| blue check | `user.is_blue_verified` | `verification.is_blue_verified` |
| business/org check | `legacy.verified` (bool) | `verification.verified_type` (`"Business"`, …) |

Traps that survived:

- `verification.verified` is `false` for business-verified accounts — @X itself reports
  `verified_type: "Business"` with no `verified` boolean. Reading only the boolean drops the
  badge.
- `location.location` exists but is frequently `""`; report it as absent, not as an empty
  string.

## Finding 5: timeline entries changed shape too

A 2026 entry is `{ entry_id, sort_index, content }` (snake case), and the post is one level
deeper than it used to be:

```
entry.content            = { __typename: "TimelineTimelineItem", content: { __typename: "TimelineTweet", tweet_results: { result } } }
entry.content (module)   = { __typename: "TimelineTimelineModule", items: [ { item: { content: { tweet_results: { result } } } } ] }
instruction (pinned)     = { __typename: "TimelinePinEntry", entry: { …same as above… } }
entry.content (cursor)   = { __typename: "TimelineTimelineCursor", cursor_type: "Top" | "Bottom", value: "<token>" }
```

Because X moves the payload between wrappers across releases, the parser does a bounded
structural search for the first object carrying `tweet_results.result` inside an entry instead
of hardcoding the path. Cursors are read from `content` or `content.content`, and only
`Bottom`/`ShowMore` cursors are treated as "next page" — a `cursor-top` token would page
backwards.

## Finding 6: paging a conversation still needs `cursor`

Unchanged and re-verified: `TweetDetail` returns the focal post, `conversationthread-*`
modules, and one `cursor-bottom-<id>` entry.

```
GET TweetDetail?variables={"focalTweetId":…,"cursor":"<token>","withFocalTweet":true}
```

Passing the token as **`cursor`** returns the next page; passing it as `cursorValue` is
silently ignored and you get page 1 again. Measured on post `20`: page 1 = 36 replies,
page 2 = 36 replies, **0 overlap**, and page 2 contains **no focal post** — a parser that
assumes "first item is the post" will mislabel a reply.

Each page's size is decided by X. `limit` only truncates locally.

## Maintenance map

| Symptom | First thing to check |
|---|---|
| `… no longer embeds the <Op> operation` | the page's record format or the page mapping (reverse-engineering.md §1, §5) |
| `422 … "must be defined"` on a relay switch | the page's variable template was not spread into the call |
| `422 … "must be defined"` on `screenName` | variable renamed at the call site |
| `404 / 422` on a freshly discovered id | query id rotated inside the cache window — the client rediscovers once by itself |
| Empty `text`, zero counts | field locations moved again (§3) |
| Timeline empty, HTTP 200 | the `data` root moved (§2 table) |
| 404 on the page | the profile or post does not exist |
| 401 / 403, or a signed-out page | cookies |
| Trends empty but HTTP 200 | wrong `woeid`, or the endpoint finally retired |

When something breaks, dump the raw response first: `XClient.graphql` is the only funnel, so a
one-off `node -e` around it shows both the discovered operation and the body. The
200-with-empty-body case wastes the most time if you assume every failure is a routing
failure.
