/**
 * 把 X 的嵌套响应拍平成稳定的领域模型。
 *
 * X 的返回结构有三层麻烦：
 * 1. 同一条推文可能被包在 TweetWithVisibilityResults 里；
 * 2. 长推文的正文在 note_tweet 而非 legacy.full_text；
 * 3. 首页时间线走的是老的 v2 REST（globalObjects + timeline.instructions），
 *    与 GraphQL 的时间线结构完全不同。
 *
 * 这里统一吸收掉，输出结构不随端点和版本变化。
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

/** X 的 "Wed Oct 10 20:19:24 +0000 2018" → ISO 8601。 */
export function toIsoDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * 用户对象。X 在 2026 年重构过：统计字段从 legacy 搬到了
 * relationship_counts / tweet_counts / profile_bio / verification / avatar 等顶层对象，
 * 这里两套都读，老的兼容新端点，新的兼容当前端点。
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

  return {
    id: user.rest_id,
    username,
    name: core.name ?? legacy.name ?? username,
    bio: (bio.description ?? legacy.description) || undefined,
    location: (user.location?.location ?? legacy.location) || undefined,
    website:
      bio.entities?.url?.urls?.[0]?.expanded_url ??
      legacy.entities?.url?.urls?.[0]?.expanded_url ??
      undefined,
    createdAt: toIsoDate(core.created_at ?? legacy.created_at),
    verified,
    blueVerified: Boolean(user.is_blue_verified),
    followers: Number(relationship.followers ?? legacy.followers_count ?? 0),
    following: Number(relationship.following ?? legacy.friends_count ?? 0),
    tweets: Number(counts.tweets ?? legacy.statuses_count ?? 0),
    likes:
      user.action_counts?.favorites_count != null
        ? Number(user.action_counts.favorites_count)
        : legacy.favourites_count != null
          ? Number(legacy.favourites_count)
          : undefined,
    // _normal 是 48px 缩略图，_400x400 更适合展示
    avatarUrl: avatar ? avatar.replace('_normal.', '_400x400.') : undefined,
    bannerUrl: user.banner?.image_url ?? legacy.profile_banner_url ?? undefined,
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

function parseMedia(legacy: Any): MediaItem[] {
  const media: Any[] = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  return media.map((item) => {
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

export function parseTweetResult(input: Any): Tweet | null {
  if (!input) return null;
  // 可见性包装
  const result = input.__typename === 'TweetWithVisibilityResults' ? input.tweet : input;
  if (!result || typeof result.rest_id !== 'string') return null;

  const legacy = result.legacy ?? {};
  // 长推文正文优先
  const noteText: string | undefined = result.note_tweet?.note_tweet_results?.result?.text;
  const text: string = noteText ?? legacy.full_text ?? '';

  const author = parseAuthor(result);
  const retweeted = parseTweetResult(
    result.retweeted_status_result?.result ?? legacy.retweeted_status_result?.result,
  );
  const quoted = parseTweetResult(
    result.quoted_status_result?.result ?? legacy.quoted_status_result?.result,
  );

  return {
    id: result.rest_id,
    url: TWEET_URL(author?.username, result.rest_id),
    text,
    createdAt: toIsoDate(legacy.created_at),
    lang: legacy.lang,
    author,
    metrics: {
      likes: Number(legacy.favorite_count ?? 0),
      retweets: Number(legacy.retweet_count ?? 0),
      replies: Number(legacy.reply_count ?? 0),
      quotes: Number(legacy.quote_count ?? 0),
      views: result.views?.count != null ? Number(result.views.count) : undefined,
    },
    media: parseMedia(legacy),
    isRetweet: Boolean(retweeted),
    isReply: Boolean(legacy.in_reply_to_status_id_str),
    inReplyToTweetId: legacy.in_reply_to_status_id_str ?? undefined,
    inReplyToUsername: legacy.in_reply_to_screen_name ?? undefined,
    quotedTweet: quoted ?? undefined,
    retweetedTweet: retweeted ?? undefined,
  };
}

/** 从 timeline instructions 里取推文与下一页游标。 */
export function parseTimelineInstructions(instructions: Any): TweetPage {
  const tweets: Tweet[] = [];
  let nextCursor: string | undefined;

  for (const instruction of instructions ?? []) {
    for (const entry of instruction?.entries ?? []) {
      const entryId: string = entry?.entryId ?? '';

      if (entryId.startsWith('cursor-bottom') || entryId.startsWith('cursor-showMore') ) {
        const value = entry?.content?.value;
        if (typeof value === 'string' && value) nextCursor = value;
        continue;
      }

      // 单条推文
      const single =
        entry?.content?.itemContent?.tweet_results?.result ??
        entry?.content?.item?.itemContent?.tweet_results?.result;
      if (single) {
        const tweet = parseTweetResult(single);
        if (tweet) tweets.push(tweet);
        continue;
      }

      // 会话模块（含多条推文）
      const items: Any[] = entry?.content?.items ?? [];
      for (const item of items) {
        const candidate = item?.item?.itemContent?.tweet_results?.result;
        const tweet = parseTweetResult(candidate);
        if (tweet) tweets.push(tweet);
      }
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
      const entryId: string = entry?.entryId ?? '';
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
