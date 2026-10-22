/**
 * 解析层单元测试。全部用合成数据，不联网——
 * 结构取自 2026-10 的真实响应（新旧两版并存），改 X 结构时这里会先红。
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

const userCurrent = {
  __typename: 'User',
  rest_id: '783214',
  is_blue_verified: true,
  core: { created_at: 'Tue Feb 20 14:35:54 +0000 2007', name: 'X', screen_name: 'X' },
  relationship_counts: { followers: 60669158, following: 1 },
  tweet_counts: { tweets: 15733, media_tweets: 2492 },
  profile_bio: { description: "what's happening?!", entities: { url: { urls: [{ expanded_url: 'https://x.com' }] } } },
  location: { location: 'everywhere' },
  verification: { verified: false, verified_type: 'Business' },
  avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg' },
  banner: { image_url: 'https://pbs.twimg.com/profile_banners/783214/1690175171' },
  action_counts: { favorites_count: 5968 },
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

const tweet = (overrides = {}) => ({
  __typename: 'Tweet',
  rest_id: '111',
  core: { user_results: { result: userCurrent } },
  legacy: {
    full_text: 'hello world',
    created_at: 'Wed Oct 21 01:48:35 +0000 2026',
    favorite_count: 5,
    retweet_count: 2,
    reply_count: 1,
    quote_count: 0,
    lang: 'en',
    ...overrides,
  },
  views: { count: '1234' },
});

describe('parseUserResult', () => {
  it('读 2026 新版用户结构', () => {
    const user = parseUserResult(userCurrent)!;
    expect(user.username).toBe('X');
    expect(user.followers).toBe(60669158);
    expect(user.tweets).toBe(15733);
    expect(user.bio).toBe("what's happening?!");
    expect(user.website).toBe('https://x.com');
    expect(user.createdAt).toBe('2007-02-20T14:35:54.000Z');
    // verified_type=Business 也算认证
    expect(user.verified).toBe(true);
    expect(user.blueVerified).toBe(true);
    expect(user.avatarUrl).toContain('_400x400');
  });

  it('仍然读老的 legacy 结构', () => {
    const user = parseUserResult(userLegacy)!;
    expect(user.username).toBe('old');
    expect(user.followers).toBe(10);
    expect(user.verified).toBe(true);
    expect(user.createdAt).toBe('2018-10-10T20:19:24.000Z');
  });

  it('没有 screen_name 时返回 null', () => {
    expect(parseUserResult({ rest_id: '1' })).toBeNull();
  });
});

describe('parseTweetResult', () => {
  it('解析正文、作者与互动数', () => {
    const result = parseTweetResult(tweet())!;
    expect(result.text).toBe('hello world');
    expect(result.author?.username).toBe('X');
    expect(result.metrics).toMatchObject({ likes: 5, retweets: 2, replies: 1, quotes: 0, views: 1234 });
    expect(result.url).toBe('https://x.com/X/status/111');
  });

  it('长推文优先用 note_tweet 正文', () => {
    const result = parseTweetResult({
      ...tweet(),
      note_tweet: { note_tweet_results: { result: { text: 'the long version' } } },
    })!;
    expect(result.text).toBe('the long version');
  });

  it('拆开 TweetWithVisibilityResults 包装', () => {
    const result = parseTweetResult({ __typename: 'TweetWithVisibilityResults', tweet: tweet() })!;
    expect(result.id).toBe('111');
  });

  it('识别转推与被引用的推文', () => {
    const result = parseTweetResult({
      ...tweet(),
      legacy: {
        ...tweet().legacy,
        retweeted_status_result: { result: { ...tweet(), rest_id: '222' } },
        quoted_status_result: { result: { ...tweet(), rest_id: '333' } },
      },
    })!;
    expect(result.isRetweet).toBe(true);
    expect(result.retweetedTweet?.id).toBe('222');
    expect(result.quotedTweet?.id).toBe('333');
  });
});

describe('parseTimelineInstructions', () => {
  it('收集推文并读出下一页游标', () => {
    const page = parseTimelineInstructions([
      {
        type: 'TimelineAddEntries',
        entries: [
          { entryId: 'tweet-111', content: { itemContent: { tweet_results: { result: tweet() } } } },
          { entryId: 'cursor-bottom-1', content: { value: 'CURSOR' } },
          {
            entryId: 'profile-conversation-1',
            content: {
              items: [
                { item: { itemContent: { tweet_results: { result: { ...tweet(), rest_id: '444' } } } } },
              ],
            },
          },
        ],
      },
    ]);
    expect(page.tweets.map((t) => t.id)).toEqual(['111', '444']);
    expect(page.nextCursor).toBe('CURSOR');
  });
});

describe('parseHomeTimeline', () => {
  it('读老 v2 的 addEntries + globalObjects 结构', () => {
    const payload = {
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
    // full_text 为空串时必须回退到 text
    payload.globalObjects.tweets['555'].full_text = '';
    const page = parseHomeTimeline(payload);
    expect(page.tweets).toHaveLength(1);
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
