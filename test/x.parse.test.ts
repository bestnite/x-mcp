/**
 * 解析层单元测试。全部合成数据，不联网——
 * 结构取自 2026-11 x-web 的真实响应（新旧两套并存），X 再改结构时这里会先红。
 */
import { describe, expect, it } from 'vitest';

import {
  parseHomeTimeline,
  parseTimelineInstructions,
  parseTrendsRest,
  parseTweetResult,
  parseUserResult,
  toIsoDate,
} from '../src/x/parse.js';

/** x-web 的用户对象：统计字段搬到了顶层，legacy 只剩几个开关。 */
const userXWeb = {
  __typename: 'User',
  rest_id: '783214',
  core: { created_at_ms: 1171982154000, name: 'X', screen_name: 'X' },
  relationship_counts: { followers: 60669158, following: 1 },
  tweet_counts: { tweets: 15733, media_tweets: 2492 },
  profile_bio: {
    description: "what's happening?!",
    entities: { description: { urls: [{ expanded_url: 'https://x.com', display_url: 'x.com' }] } },
  },
  location: { location: '' },
  verification: { is_blue_verified: true, verified_type: 'Business' },
  avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg' },
  banner: { image_url: 'https://pbs.twimg.com/profile_banners/783214/1690175171' },
  action_counts: { favorites_count: 5968 },
  legacy: { can_dm: false },
};

const userLegacy = {
  __typename: 'User',
  rest_id: '42',
  legacy: {
    screen_name: 'old',
    name: 'Old Shape',
    description: 'bio',
    followers_count: 10,
    friends_count: 5,
    statuses_count: 3,
    favourites_count: 1,
    verified: true,
    created_at: 'Wed Oct 10 20:19:24 +0000 2018',
    profile_image_url_https: 'https://pbs.twimg.com/profile_images/2/x_normal.png',
  },
};

/** x-web 的推文对象：正文在 details、计数在 counts、媒体在 media_entities2。 */
const tweetXWeb = (overrides: Record<string, unknown> = {}) => ({
  __typename: 'Tweet',
  rest_id: '111',
  core: { user_results: { result: userXWeb } },
  details: {
    full_text: 'hello world',
    created_at_ms: 1794909662000,
    display_text_range: [0, 11],
  },
  counts: { favorite_count: 5, retweet_count: 2, reply_count: 1, quote_count: 0, bookmark_count: 3 },
  legacy: { conversation_id_str: '111', lang: 'en', entities: {} },
  views: { count: '1234' },
  ...overrides,
});

const entryOf = (result: unknown, entryId = 'tweet-111') => ({
  entry_id: entryId,
  content: {
    __typename: 'TimelineTimelineItem',
    content: { __typename: 'TimelineTweet', tweet_results: { result } },
  },
});

describe('parseUserResult', () => {
  it('读 x-web 的用户结构', () => {
    const user = parseUserResult(userXWeb)!;
    expect(user.username).toBe('X');
    expect(user.followers).toBe(60669158);
    expect(user.following).toBe(1);
    expect(user.tweets).toBe(15733);
    expect(user.bio).toBe("what's happening?!");
    expect(user.website).toBe('https://x.com');
    // 时间从 core.created_at_ms 来，legacy.created_at 已经是空的
    expect(user.createdAt).toBe('2007-02-20T14:35:54.000Z');
    // verified_type=Business 也算认证；蓝标在 verification.is_blue_verified
    expect(user.verified).toBe(true);
    expect(user.blueVerified).toBe(true);
    expect(user.avatarUrl).toContain('_400x400');
    expect(user.bannerUrl).toContain('profile_banners');
    // 空字符串的地点当没有，不要漏成 ''
    expect(user.location).toBeUndefined();
  });

  it('仍然读老的结构', () => {
    const user = parseUserResult(userLegacy)!;
    expect(user.username).toBe('old');
    expect(user.followers).toBe(10);
    expect(user.verified).toBe(true);
    expect(user.createdAt).toBe('2018-10-10T20:19:24.000Z');
    expect(user.likes).toBe(1);
  });

  it('没有 screen_name 时返回 null', () => {
    expect(parseUserResult({ rest_id: '1' })).toBeNull();
  });
});

describe('parseTweetResult', () => {
  it('读 x-web 的正文、时间与计数', () => {
    const result = parseTweetResult(tweetXWeb())!;
    expect(result.text).toBe('hello world');
    expect(result.createdAt).toBe(new Date(1794909662000).toISOString());
    expect(result.lang).toBe('en');
    expect(result.author?.username).toBe('X');
    expect(result.metrics).toMatchObject({ likes: 5, retweets: 2, replies: 1, quotes: 0, views: 1234 });
    expect(result.url).toBe('https://x.com/X/status/111');
  });

  it('没有 details 时回退到 legacy 的字段', () => {
    const legacyOnly = {
      __typename: 'Tweet',
      rest_id: '222',
      core: { user_results: { result: userLegacy } },
      legacy: {
        full_text: 'legacy text',
        created_at: 'Wed Oct 21 01:48:35 +0000 2026',
        favorite_count: 9,
        retweet_count: 3,
        reply_count: 2,
        quote_count: 1,
        lang: 'ja',
      },
    };
    const result = parseTweetResult(legacyOnly)!;
    expect(result.text).toBe('legacy text');
    expect(result.createdAt).toBe('2026-10-21T01:48:35.000Z');
    expect(result.metrics).toMatchObject({ likes: 9, retweets: 3, replies: 2, quotes: 1 });
    expect(result.views).toBeUndefined();
  });

  it('长推文优先用 note_tweet 正文', () => {
    const result = parseTweetResult({
      ...tweetXWeb(),
      note_tweet: { note_tweet_results: { result: { text: 'the long version' } } },
    })!;
    expect(result.text).toBe('the long version');
  });

  it('拆开 TweetWithVisibilityResults 包装', () => {
    const result = parseTweetResult({ __typename: 'TweetWithVisibilityResults', tweet: tweetXWeb() })!;
    expect(result.id).toBe('111');
  });

  it('读 media_entities2：视频取码率最高的 mp4', () => {
    const result = parseTweetResult({
      ...tweetXWeb(),
      media_entities2: [
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/thumb.jpg',
          original_info: { width: 1920, height: 1080 },
          video_info: {
            variants: [
              { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8' },
              { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/low.mp4' },
              { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/high.mp4' },
            ],
          },
        },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/photo.jpg' },
      ],
    })!;
    expect(result.media).toHaveLength(2);
    expect(result.media[0]).toMatchObject({ type: 'video', url: 'https://video.twimg.com/high.mp4', width: 1920 });
    expect(result.media[1]).toMatchObject({ type: 'photo', url: 'https://pbs.twimg.com/photo.jpg' });
  });

  it('读 reply_to_results / quoted_tweet_results', () => {
    const result = parseTweetResult({
      ...tweetXWeb(),
      reply_to_results: { rest_id: '999' },
      reply_to_user_results: { result: { core: { screen_name: 'someone' } } },
      quoted_tweet_results: { result: { ...tweetXWeb(), rest_id: '333' } },
    })!;
    expect(result.isReply).toBe(true);
    expect(result.inReplyToTweetId).toBe('999');
    expect(result.inReplyToUsername).toBe('someone');
    expect(result.quotedTweet?.id).toBe('333');
  });

  it('识别转推', () => {
    const result = parseTweetResult({
      ...tweetXWeb(),
      retweeted_post_results: { result: { ...tweetXWeb(), rest_id: '222' } },
    })!;
    expect(result.isRetweet).toBe(true);
    expect(result.retweetedTweet?.id).toBe('222');
  });
});

describe('parseTimelineInstructions', () => {
  it('读 x-web 的 entry 形状：条目、模块、置顶、游标', () => {
    const page = parseTimelineInstructions([
      { __typename: 'TimelineClearCache' },
      { __typename: 'TimelinePinEntry', entry: entryOf({ ...tweetXWeb(), rest_id: '900' }, 'tweet-900') },
      {
        __typename: 'TimelineAddEntries',
        entries: [
          entryOf(tweetXWeb()),
          {
            entry_id: 'conversationthread-1',
            content: {
              __typename: 'TimelineTimelineModule',
              items: [
                {
                  item: {
                    __typename: 'TimelineTimelineItem',
                    content: {
                      __typename: 'TimelineTweet',
                      tweet_results: { result: { ...tweetXWeb(), rest_id: '444' } },
                    },
                  },
                },
              ],
            },
          },
          {
            entry_id: 'cursor-top-9223372036854775807',
            content: { __typename: 'TimelineTimelineCursor', cursor_type: 'Top', value: 'TOP' },
          },
          {
            entry_id: 'cursor-bottom-9223372036854775807',
            content: { __typename: 'TimelineTimelineCursor', cursor_type: 'Bottom', value: 'BOTTOM' },
          },
        ],
      },
    ]);
    expect(page.tweets.map((t) => t.id)).toEqual(['900', '111', '444']);
    // 只有 bottom 游标才算下一页
    expect(page.nextCursor).toBe('BOTTOM');
  });

  it('游标在 content.content 下面时也能读', () => {
    const page = parseTimelineInstructions([
      {
        entries: [
          { entry_id: 'cursor-bottom-1', content: { content: { cursor_type: 'Bottom', value: 'NEXT' } } },
        ],
      },
    ]);
    expect(page.nextCursor).toBe('NEXT');
  });

  it('读老结构的 entryId + itemContent', () => {
    const page = parseTimelineInstructions([
      {
        type: 'TimelineAddEntries',
        entries: [{ entryId: 'tweet-111', content: { itemContent: { tweet_results: { result: tweetXWeb() } } } }],
      },
    ]);
    expect(page.tweets.map((t) => t.id)).toEqual(['111']);
  });
});

describe('parseHomeTimeline', () => {
  it('读老 v2 的 addEntries + globalObjects 结构', () => {
    const payload: any = {
      globalObjects: {
        users: { u1: { id_str: 'u1', screen_name: 'someone', name: 'Someone', verified: false } },
        tweets: {
          '555': {
            id_str: '555',
            text: 'home tweet',
            created_at: 'Wed Oct 21 01:48:35 +0000 2026',
            user_id_str: 'u1',
            favorite_count: 7,
            retweet_count: 1,
            reply_count: 0,
            quote_count: 0,
            full_text: '',
          },
        },
      },
      timeline: {
        instructions: [
          {
            addEntries: {
              entries: [
                { entryId: 'tweet-555', content: { item: { content: { tweet: { id: '555' } } } } },
                { entryId: 'cursor-bottom-9', content: { value: 'NEXT' } },
              ],
            },
          },
        ],
      },
    };
    const page = parseHomeTimeline(payload);
    expect(page.tweets).toHaveLength(1);
    // full_text 为空串时必须回退到 text
    expect(page.tweets[0].text).toBe('home tweet');
    expect(page.tweets[0].author?.username).toBe('someone');
    expect(page.tweets[0].metrics.likes).toBe(7);
    expect(page.nextCursor).toBe('NEXT');
  });
});

describe('parseTrendsRest', () => {
  it('读 v1.1 trends/place.json', () => {
    const trends = parseTrendsRest([
      {
        trends: [
          { name: '#One', query: '%23One', url: 'https://x.com/search?q=%23One', tweet_volume: 12000 },
          { name: 'Two', query: 'Two', url: 'https://x.com/search?q=Two', promoted_content: {} },
        ],
      },
    ]);
    expect(trends).toHaveLength(2);
    expect(trends[0]).toMatchObject({ name: '#One', rank: 1, tweetCount: 12000 });
    expect(trends[1]).toMatchObject({ rank: 2, promoted: true });
  });
});

describe('toIsoDate', () => {
  it('转换 X 的日期格式，非法值返回 undefined', () => {
    expect(toIsoDate('Wed Oct 21 01:48:35 +0000 2026')).toBe('2026-10-21T01:48:35.000Z');
    expect(toIsoDate('not a date')).toBeUndefined();
    expect(toIsoDate(undefined)).toBeUndefined();
  });
});
