/**
 * 把 X 的嵌套响应拍平成稳定的领域模型。
 *
 * 2026-11 的 x-web 构建把字段搬了家，这里同时认新旧两套：
 * - 正文：`note_tweet` → `details.full_text` → `legacy.full_text` → `text`
 * - 时间：`details.created_at_ms` → `details.created_at` → `legacy.created_at`
 * - 计数：`counts.*` → `legacy.*`（legacy 现在基本是空壳）
 * - 媒体：`media_entities2` → `legacy.extended_entities.media`
 * - 作者：`core.user_results.result`（未变）
 * - 回复：`reply_to_results` / `reply_to_user_results`（不再是 legacy 的 in_reply_to_*）
 *
 * 时间线入口也换了形状：`entry_id`（蛇形）+ `content.content` 两层包装，
 * 游标在 `content.cursor_type/value`。所以取推文一律用有界结构搜索，
 * 不写死路径——X 把 Tweet 从一层包装挪到另一层是常态。
 */

export interface AuthorSummary {
  id: string;
  username: string;
  name: string;
  verified: boolean;
}

export interface MediaItem {
  type: 'photo' | 'video' | 'gif' | 'unknown';
  url: string;
  altText?: string;
  width?: number;
  height?: number;
}

export interface Tweet {
  id: string;
  url: string;
  text: string;
  createdAt?: string;
  lang?: string;
  author?: AuthorSummary;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    views?: number;
  };
  media: MediaItem[];
  isRetweet: boolean;
  isReply: boolean;
  inReplyToTweetId?: string;
  inReplyToUsername?: string;
  quotedTweet?: Tweet;
  retweetedTweet?: Tweet;
}

export interface User {
  id: string;
  username: string;
  name: string;
  bio?: string;
  location?: string;
  website?: string;
  createdAt?: string;
  verified: boolean;
  blueVerified: boolean;
  followers: number;
  following: number;
  tweets: number;
  likes?: number;
  avatarUrl?: string;
  bannerUrl?: string;
}

export interface Trend {
  name: string;
  query: string;
  url: string;
  rank: number;
  tweetCount?: number;
  promoted: boolean;
}

export interface TweetPage {
  tweets: Tweet[];
  nextCursor?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const TWEET_URL = (username: string | undefined, id: string): string =>
  username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

/** X 的 "Wed Oct 10 20:19:24 +0000 2018" → ISO 8601。 */
export function toIsoDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** 毫秒时间戳 → ISO 8601。 */
function toIsoFromMillis(raw: unknown): string | undefined {
  const millis = asNumber(raw);
  if (millis === undefined) return undefined;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * 用户对象。X 把统计字段从 legacy 搬到了 relationship_counts / tweet_counts /
 * profile_bio / verification / avatar 等顶层对象；legacy 里现在只剩几个开关。
 * 两套都读：新的给当前端点，老的给还没迁移的端点。
 */
export function parseUserResult(result: Any): User | null {
  const user = result?.__typename === 'UserWithVisibilityResults' ? result.user : result;
  if (!user || typeof user.rest_id !== 'string') return null;

  const core = user.core ?? {};
  const legacy = user.legacy ?? {};
  const relationship = user.relationship_counts ?? {};
  const counts = user.tweet_counts ?? {};
  const bio = user.profile_bio ?? {};
  const verification = user.verification ?? {};

  const username = core.screen_name ?? legacy.screen_name;
  if (!username) return null;

  const verifiedType: string | undefined = verification.verified_type;
  const verified =
    Boolean(verification.verified) ||
    Boolean(legacy.verified) ||
    Boolean(verifiedType && verifiedType !== 'None');

  const avatar = (user.avatar?.image_url ?? legacy.profile_image_url_https) as string | undefined;
  const site =
    bio.entities?.description?.urls?.[0]?.expanded_url ??
    bio.entities?.url?.urls?.[0]?.expanded_url ??
    legacy.entities?.url?.urls?.[0]?.expanded_url ??
    undefined;

  return {
    id: user.rest_id,
    username,
    name: core.name ?? legacy.name ?? username,
    bio: (bio.description ?? legacy.description) || undefined,
    location: user.location?.location || legacy.location || undefined,
    website: site,
    createdAt: toIsoFromMillis(core.created_at_ms) ?? toIsoDate(core.created_at ?? legacy.created_at),
    verified,
    blueVerified: Boolean(verification.is_blue_verified ?? user.is_blue_verified),
    followers: asNumber(relationship.followers ?? legacy.followers_count) ?? 0,
    following: asNumber(relationship.following ?? legacy.friends_count) ?? 0,
    tweets: asNumber(counts.tweets ?? legacy.statuses_count) ?? 0,
    likes: asNumber(user.action_counts?.favorites_count ?? legacy.favourites_count),
    // _normal 是 48px 缩略图，_400x400 更适合展示
    avatarUrl: avatar ? avatar.replace('_normal.', '_400x400.') : undefined,
    bannerUrl: (user.banner?.image_url ?? legacy.profile_banner_url) || undefined,
  };
}

function parseAuthor(result: Any): AuthorSummary | undefined {
  const user = result?.core?.user_results?.result;
  const parsed = parseUserResult(user);
  if (!parsed) return undefined;
  return {
    id: parsed.id,
    username: parsed.username,
    name: parsed.name,
    verified: parsed.verified || parsed.blueVerified,
  };
}

function bestVideoUrl(videoInfo: Any): string | undefined {
  const variants: Any[] = videoInfo?.variants ?? [];
  const mp4 = variants
    .filter((v) => typeof v?.url === 'string' && (v.content_type === 'video/mp4' || v.url.includes('.mp4')))
    .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));
  return mp4[0]?.url;
}

/** media_entities2（x-web）与 legacy 的 media 数组结构一致，一套解析。 */
function parseMediaItems(items: Any[]): MediaItem[] {
  return items.map((item) => {
    const type = item?.type === 'photo' || item?.type === 'video' || item?.type === 'animated_gif'
      ? item.type === 'animated_gif'
        ? 'gif'
        : item.type
      : 'unknown';
    const videoUrl = bestVideoUrl(item?.video_info);
    return {
      type,
      url: videoUrl ?? item?.media_url_https ?? '',
      altText: item?.ext_alt_text ?? undefined,
      width: item?.original_info?.width ?? undefined,
      height: item?.original_info?.height ?? undefined,
    } satisfies MediaItem;
  });
}

function parseMedia(tweet: Any): MediaItem[] {
  const legacy = tweet?.legacy ?? {};
  const items: Any[] =
    tweet?.media_entities2 ?? legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  return parseMediaItems(items);
}

/** 同一条推文可能被包在 TweetWithVisibilityResults / TweetUnavailable 里。 */
function unwrapTweet(input: Any): Any {
  if (!input || typeof input !== 'object') return undefined;
  if (input.__typename === 'TweetWithVisibilityResults') return input.tweet;
  return input;
}

export function parseTweetResult(input: Any): Tweet | null {
  const result = unwrapTweet(input);
  if (!result || typeof result.rest_id !== 'string') return null;

  const legacy = result.legacy ?? {};
  const details = result.details ?? {};
  const counts = result.counts ?? {};

  // 长推文正文优先；x-web 把普通正文放到 details.full_text，legacy 里已经是空的
  const noteText: string | undefined = result.note_tweet?.note_tweet_results?.result?.text;
  const text: string = noteText ?? details.full_text ?? legacy.full_text ?? result.text ?? '';

  const author = parseAuthor(result);
  const retweeted = parseTweetResult(
    result.retweeted_post_results?.result ??
      result.retweeted_status_result?.result ??
      legacy.retweeted_status_result?.result,
  );
  const quoted = parseTweetResult(
    result.quoted_tweet_results?.result ??
      result.quoted_status_result?.result ??
      legacy.quoted_status_result?.result,
  );

  const replyToId: string | undefined =
    result.reply_to_results?.rest_id ?? legacy.in_reply_to_status_id_str ?? undefined;
  const replyToUsername: string | undefined =
    result.reply_to_user_results?.result?.core?.screen_name ?? legacy.in_reply_to_screen_name ?? undefined;

  return {
    id: result.rest_id,
    url: TWEET_URL(author?.username, result.rest_id),
    text,
    createdAt:
      toIsoFromMillis(details.created_at_ms) ?? toIsoDate(details.created_at ?? legacy.created_at),
    lang: legacy.lang ?? details.lang ?? undefined,
    author,
    metrics: {
      likes: asNumber(counts.favorite_count ?? legacy.favorite_count) ?? 0,
      retweets: asNumber(counts.retweet_count ?? legacy.retweet_count) ?? 0,
      replies: asNumber(counts.reply_count ?? legacy.reply_count) ?? 0,
      quotes: asNumber(counts.quote_count ?? legacy.quote_count) ?? 0,
      views: asNumber(result.views?.count),
    },
    media: parseMedia(result),
    isRetweet: Boolean(retweeted),
    isReply: Boolean(replyToId),
    inReplyToTweetId: replyToId,
    inReplyToUsername: replyToUsername,
    quotedTweet: quoted ?? undefined,
    retweetedTweet: retweeted ?? undefined,
  };
}

/**
 * 在一个 entry 里找推文。X 把 Tweet 放在 `content.content`、模块的
 * `content.items[].item.content`，或者更深的包装里，所以用有界结构搜索而不是固定路径。
 */
function findTweetResult(entry: Any): Any | undefined {
  const queue: unknown[] = [entry];
  let visited = 0;
  while (queue.length > 0 && visited < 64) {
    const current = queue.shift();
    visited += 1;
    if (!current || typeof current !== 'object') continue;
    const value = current as Any;
    const candidate = value.tweet_results?.result;
    if (candidate && typeof candidate === 'object') return candidate;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return undefined;
}

/** 游标记录：`content.cursor_type/value`（可以是 entry.content 或 entry.content.content）。 */
function readCursor(entry: Any): { type: string; value: string } | undefined {
  const candidates = [entry?.content, entry?.content?.content];
  for (const content of candidates) {
    const type = content?.cursor_type;
    const value = content?.value;
    if (typeof value === 'string' && value) {
      return { type: typeof type === 'string' ? type : '', value };
    }
  }
  const entryId: string = entry?.entry_id ?? entry?.entryId ?? '';
  if (entryId.startsWith('cursor-') && typeof entry?.content?.value === 'string') {
    return { type: entryId.slice('cursor-'.length), value: entry.content.value };
  }
  return undefined;
}

const isBottomCursor = (cursor: { type: string; value: string }): boolean =>
  cursor.type === 'Bottom' || cursor.type === 'ShowMore' || cursor.type === 'showMore';

/** 从 timeline instructions 里取推文与下一页游标。 */
export function parseTimelineInstructions(instructions: Any): TweetPage {
  const tweets: Tweet[] = [];
  let nextCursor: string | undefined;

  for (const instruction of instructions ?? []) {
    // 老 v2 的 instructions 是 {addEntries:{entries}} / {pinEntry:{entry}}
    const entries: Any[] = [
      ...(instruction?.entries ?? []),
      ...(instruction?.addEntries?.entries ?? []),
      ...(instruction?.entry ? [instruction.entry] : []),
      ...(instruction?.pinEntry?.entry ? [instruction.pinEntry.entry] : []),
    ];

    for (const entry of entries) {
      const cursor = readCursor(entry);
      if (cursor) {
        if (isBottomCursor(cursor)) nextCursor = cursor.value;
        continue;
      }

      const result = findTweetResult(entry);
      const tweet = parseTweetResult(result);
      if (tweet) tweets.push(tweet);
    }
  }

  return { tweets, nextCursor };
}

/** v1.1 trends/place.json 的返回结构。 */
export function parseTrendsRest(payload: Any): Trend[] {
  const places: Any[] = Array.isArray(payload) ? payload : payload?.trends ? [payload] : [];
  const trends: Trend[] = [];
  let rank = 1;
  for (const place of places) {
    for (const item of place?.trends ?? []) {
      if (!item?.name) continue;
      trends.push({
        name: item.name,
        query: item.query ?? item.name,
        url: item.url ?? `https://x.com/search?q=${encodeURIComponent(item.query ?? item.name)}`,
        rank: rank++,
        tweetCount: item.tweet_volume != null ? Number(item.tweet_volume) : undefined,
        promoted: Boolean(item.promoted_content),
      });
    }
  }
  return trends;
}

/** 首页时间线（v2 REST，globalObjects 结构）。 */
export function parseHomeTimeline(payload: Any): TweetPage {
  const objects = payload?.globalObjects ?? {};
  const tweetsById: Record<string, Any> = objects.tweets ?? {};
  const usersById: Record<string, Any> = objects.users ?? {};
  const tweets: Tweet[] = [];
  let nextCursor: string | undefined;

  // 老 v2 的 instructions 是 {addEntries:{entries}} 而不是 {type, entries}
  const entriesOf = (instruction: Any): Any[] =>
    instruction?.entries ?? instruction?.addEntries?.entries ?? [];

  for (const instruction of payload?.timeline?.instructions ?? []) {
    for (const entry of entriesOf(instruction)) {
      const entryId: string = entry?.entryId ?? entry?.entry_id ?? '';
      if (entryId.includes('cursor-bottom') || entryId.includes('cursor-showMore')) {
        const value = entry?.content?.value ?? entry?.content?.operation?.cursor?.value;
        if (typeof value === 'string' && value) nextCursor = value;
        continue;
      }

      // 推文 id 在 content.item.content.tweet.id（有三层包装）
      const tweetId: string | undefined =
        entry?.content?.tweet?.id?.toString?.() ??
        entry?.content?.item?.content?.tweet?.id?.toString?.() ??
        (entryId.startsWith('tweet-') ? entryId.slice('tweet-'.length) : undefined);
      if (!tweetId) continue;

      const raw = tweetsById[tweetId];
      if (!raw) continue;
      const user = usersById[raw.user_id_str];

      const retweetedRaw = raw.retweeted_status_id_str ? tweetsById[raw.retweeted_status_id_str] : undefined;
      const retweetedUser = retweetedRaw ? usersById[retweetedRaw.user_id_str] : undefined;

      const toAuthor = (u: Any): AuthorSummary | undefined =>
        u
          ? {
              id: String(u.id_str ?? ''),
              username: u.screen_name ?? '',
              name: u.name ?? u.screen_name ?? '',
              verified: Boolean(u.verified),
            }
          : undefined;

      const buildTweet = (t: Any, u: Any): Tweet => ({
        id: String(t.id_str ?? ''),
        url: TWEET_URL(u?.screen_name, String(t.id_str ?? '')),
        // full_text 在部分端点是空串，必须用 || 而不是 ??
        text: t.full_text || t.text || '',
        createdAt: toIsoDate(t.created_at),
        lang: t.lang,
        author: toAuthor(u),
        metrics: {
          likes: Number(t.favorite_count ?? 0),
          retweets: Number(t.retweet_count ?? 0),
          replies: Number(t.reply_count ?? 0),
          quotes: Number(t.quote_count ?? 0),
        },
        media: parseMedia(t),
        isRetweet: Boolean(t.retweeted_status_id_str),
        isReply: Boolean(t.in_reply_to_status_id_str),
        inReplyToTweetId: t.in_reply_to_status_id_str,
        inReplyToUsername: t.in_reply_to_screen_name,
      });

      const outer = buildTweet(raw, user);
      if (retweetedRaw) {
        outer.retweetedTweet = buildTweet(retweetedRaw, retweetedUser);
        // 外层展示的是被转推的内容，作者取原文作者
        if (retweetedUser) outer.author = toAuthor(retweetedUser);
      }
      tweets.push(outer);
    }
  }

  return { tweets, nextCursor };
}
