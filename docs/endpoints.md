# Read endpoints: what they are, and how they were found

Companion to [reverse-engineering.md](reverse-engineering.md). That file covers *signing*;
this one covers *routing* — which operation or REST path serves each read capability, and
what the 2026 wave of breaking changes actually looked like from the outside.

Everything below was verified against a live account on 2026-10-23.

## The six capabilities

| MCP tool | Transport | Target |
|---|---|---|
| `x_user_lookup` | GraphQL | `UserByScreenName` (`screen_name`, `withSafetyModeUserFields`) |
| `x_user_tweets` | GraphQL | `UserTweets` (`userId`, `count`, `withV2Timeline: true`) |
| `x_home_timeline` | **REST v2** | `/i/api/2/timeline/home.json` |
| `x_search` | GraphQL | `SearchTimeline` (`rawQuery`, `count`, `product`, `querySource`) |
| `x_tweet_detail` | GraphQL | `TweetDetail` (`focalTweetId`, …) |
| `x_trends` | **REST v1.1** | `/i/api/1.1/trends/place.json?id=<woeid>` |

GraphQL queryIds are never hardcoded — they come from `main.js` at runtime
(see `src/x/operations.ts`).

## Finding 1: `HomeTimeline` no longer exists as an operation

The homepage's own bundle lists **104** operations. None of them is `HomeTimeline`,
`HomeLatestTimeline`, `FollowingTimeline` or anything similar — the only home-ish names are
`TVHomeMixer` and `ExplorePage`.

Dead ends that were actually tried (all HTTP 200 with an **empty** `data`):

```
GenericTimelineById  timelineId=Home | HomeLatest | HomeLatestTimeline
                     | Following | ForYou | for_you | home     → data: {}
```

That 200-with-empty-body is worth remembering: it is *not* the same failure as a bad
queryId (which gives 404/422). An operation can exist, accept the request, and simply have
nothing to return for those variables.

What does work is the old v2 REST endpoint, which still answers with the pre-GraphQL
envelope:

```
GET /i/api/2/timeline/home.json?count=20&tweet_mode=full
→ 200, { globalObjects: { tweets, users, … }, timeline: { instructions } }
```

Two quirks of that envelope:

- `timeline.instructions[0]` is `{ addEntries: { entries: [...] } }` — **no `type` field**,
  unlike GraphQL timelines.
- Each entry's post id sits at `content.item.content.tweet.id` (three levels), and the post
  body lives separately in `globalObjects.tweets`. `full_text` is often an empty string even
  with `tweet_mode=full`, so fall back to `text` with `||`, not `??`.

It also does **not** require a transaction id: identical bytes with and without the header.
We still send one for consistency.

## Finding 2: most of v1.1 is dead, but trends survived

`account/settings.json` and `verify_credentials.json` return `{"code":34}` (page does not
exist). But the trends endpoint is untouched:

```
GET /i/api/1.1/trends/place.json?id=1   → 200, [{ trends: [ { name, query, url, tweet_volume } ] }]
GET /i/api/1.1/guide/trends.json?id=1   → 404 code 34
```

50 trends came back for `woeid=1`. Practical note: an endpoint being "v1.1" says nothing
about whether it is alive — check per path, not per version.

## Finding 3: the User object was restructured (and `legacy` stopped being enough)

`UserByScreenName` in 2026 returns statistics at the **top level**, not under `legacy`:

| Field | 2025 shape | 2026 shape |
|---|---|---|
| handle / name / joined | `legacy.screen_name`, `legacy.name`, `legacy.created_at` | `core.*` (same order; `legacy` often absent) |
| followers / following | `legacy.followers_count`, `legacy.friends_count` | `relationship_counts.followers` / `.following` |
| post count | `legacy.statuses_count` | `tweet_counts.tweets` |
| bio | `legacy.description` | `profile_bio.description` |
| avatar / banner | `legacy.profile_image_url_https`, `legacy.profile_banner_url` | `avatar.image_url`, `banner.image_url` |
| likes given | `legacy.favourites_count` | `action_counts.favorites_count` |
| verification | `legacy.verified` (bool) | `verification.verified` + `verification.verified_type` |
| protected | `legacy.protected` | `privacy.protected` |

Two traps:

- `verification.verified` is `false` for business-verified accounts — @X itself reports
  `verified: false, verified_type: "Business"`. Treating only the boolean drops the badge.
- Post objects still use `legacy` (`full_text`, `favorite_count`, …). Only the *user* moved.
  A blanket "legacy is gone" refactor breaks tweet parsing.

`src/x/parse.ts` reads both shapes and prefers whichever is present.

## Finding 4: `UserTweets` timeline moved one level

```
2025: data.user.result.timeline_v2.timeline.instructions
2026: data.user.result.timeline.timeline.instructions
```

Note the doubled `timeline`. Both are handled.

## Finding 5: paging a conversation needs `cursor`, not `cursorValue`

`TweetDetail` returns its replies as `conversationthread-*` entries plus one
`cursor-bottom-<id>` whose `content.value` is the next-page token:

```
GET TweetDetail?variables={"focalTweetId":…,"cursor":"<token>"}
```

Passing the token as **`cursor`** returns the next page (36 replies, zero overlap with page 1
in testing). Passing it as `cursorValue` is silently ignored and you get page 1 again — no
error, just duplicate data, which is the kind of bug that reads as "there are no more
replies".

Two more details:

- A paged response does **not** contain the focal post, only further replies. A parser that
  assumes "first tweet in the timeline is the focal post" will mislabel a reply.
- Each page's size is decided by X. `limit` only truncates locally, so asking for 40 does not
  make X return more than it wanted to.

## Maintenance map

| Symptom | First thing to check |
|---|---|
| `UserXxx returned no timeline` | the instructions path — X keeps moving it one level |
| 200 but empty `data` | wrong variables (this is *not* an expired queryId) |
| 404 / 422 | expired queryId (auto-refreshed) or dead signer |
| 401 / 403 | cookies |
| Trends empty but HTTP 200 | `woeid` wrong, or the endpoint finally retired |
| Follower counts are 0 | user stats moved again; inspect the raw object before assuming a parse bug |

When something breaks, dump the raw response first (`scripts/` has no debugger for this yet —
the quickest route is a one-off `node -e` against `XClient.graphql`). The 200-with-empty-body
case is the one that wastes the most time if you assume every failure is a routing failure.
