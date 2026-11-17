/**
 * XApi 的分页与数据根位置。用假的 XClient 记录请求——两处最容易写错：
 * cursor 的变量名，以及每条 operation 的 data 根在 x-web 里换了位置。
 */
import { describe, expect, it } from 'vitest';

import { XApi } from '../src/x/api.js';
import type { PageSpec } from '../src/x/operations.js';

const tweetNode = (id: string) => ({
  __typename: 'Tweet',
  rest_id: id,
  details: { full_text: `text ${id}`, created_at_ms: 1794909662000 },
  legacy: { lang: 'en' },
  core: {
    user_results: { result: { rest_id: 'u1', core: { screen_name: 'someone', name: 'Someone' } } },
  },
});

const tweetEntry = (id: string) => ({
  entry_id: `tweet-${id}`,
  content: {
    __typename: 'TimelineTimelineItem',
    content: { __typename: 'TimelineTweet', tweet_results: { result: tweetNode(id) } },
  },
});

const cursorEntry = (value: string) => ({
  entry_id: 'cursor-bottom-1',
  content: { __typename: 'TimelineTimelineCursor', cursor_type: 'Bottom', value },
});

const conversation = (ids: string[], cursor = 'NEXT_CURSOR') => ({
  threaded_conversation_with_injections_v2: {
    instructions: [{ __typename: 'TimelineAddEntries', entries: [...ids.map(tweetEntry), cursorEntry(cursor)] }],
  },
});

function fakeClient(response: unknown) {
  const calls: { name: string; page: PageSpec; vars: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      graphql: async (name: string, page: PageSpec, vars: Record<string, unknown>) => {
        calls.push({ name, page, vars });
        return response;
      },
      rest: async () => ({}),
      probeSession: async () => ({ ok: true as const }),
      resolveUsername: async (id: string) => `resolved-${id}`,
      operations: { size: 0, get: async () => ({}), refresh: async () => ({}) },
    } as never,
  };
}

describe('getTweetDetail 分页', () => {
  it('不带 cursor 时：返回焦点推文 + 回复 + nextCursor，且请求里没有 cursor 字段', async () => {
    const { client, calls } = fakeClient(conversation(['111', '222', '333']));
    const api = new XApi(client);

    const page = await api.getTweetDetail('111', 10);

    expect(page.tweet?.id).toBe('111');
    expect(page.replies.map((r) => r.id)).toEqual(['222', '333']);
    expect(page.nextCursor).toBe('NEXT_CURSOR');
    expect('cursor' in calls[0].vars).toBe(false);
    expect(calls[0].name).toBe('TweetDetail');
    expect(calls[0].page).toEqual({ kind: 'status', tweetId: '111' });
  });

  it('带 cursor 时：把游标原样传给 TweetDetail，且 tweet 为 null（后续页不含焦点推文）', async () => {
    const { client, calls } = fakeClient(conversation(['222', '333'], 'ANOTHER'));
    const api = new XApi(client);

    const page = await api.getTweetDetail('111', 10, 'CURSOR_VALUE');

    expect(calls[0].vars.cursor).toBe('CURSOR_VALUE');
    expect(calls[0].vars.focalTweetId).toBe('111');
    // 后续页没有焦点推文，不能把第一条回复当成它
    expect(page.tweet).toBeNull();
    expect(page.replies.map((r) => r.id)).toEqual(['222', '333']);
    expect(page.nextCursor).toBe('ANOTHER');
  });

  it('limit 只截断本页条数，不影响游标', async () => {
    const { client } = fakeClient(conversation(['111', '2', '3', '4', '5']));
    const api = new XApi(client);

    const page = await api.getTweetDetail('111', 2);
    expect(page.replies).toHaveLength(2);
    expect(page.nextCursor).toBe('NEXT_CURSOR');
  });
});

describe('每条能力的 data 根', () => {
  it('搜索读 search_by_raw_query，发现页面就是这次查询的搜索页', async () => {
    const { client, calls } = fakeClient({
      search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [tweetEntry('777')] }] } } },
    });
    const page = await new XApi(client).search('mcp server', 5, 'Top');

    expect(page.tweets.map((t) => t.id)).toEqual(['777']);
    expect(calls[0]).toMatchObject({
      name: 'SearchByRawQuery',
      page: { kind: 'search', query: 'mcp server' },
      vars: { rawQuery: 'mcp server', count: 5, product: 'Top', querySource: 'typed_query', cursor: null },
    });
  });

  it('用户时间线读 user_result_by_screen_name.profile_user_originals_timeline', async () => {
    const { client, calls } = fakeClient({
      user_result_by_screen_name: {
        result: {
          profile_user_originals_timeline: { timeline: { instructions: [{ entries: [tweetEntry('888')] }] } },
        },
      },
    });
    const page = await new XApi(client).getUserTweets('@X', 3);

    expect(page.tweets.map((t) => t.id)).toEqual(['888']);
    expect(calls[0]).toMatchObject({
      name: 'UserOriginalsTimeline',
      page: { kind: 'profile', username: 'X' },
      vars: { screenName: 'X', count: 3, cursor: null },
    });
  });

  it('数字 id 先换成 handle，再去读时间线', async () => {
    const { client, calls } = fakeClient({ user_result_by_screen_name: { result: {} } });
    const api = new XApi(client);

    await expect(api.getUserTweets('44196397', 3)).rejects.toMatchObject({ code: 'upstream' });
    expect(calls[0].page).toEqual({ kind: 'profile', username: 'resolved-44196397' });
  });

  it('用户资料读 user_result_by_screen_name.result', async () => {
    const { client, calls } = fakeClient({
      user_result_by_screen_name: {
        result: {
          rest_id: '783214',
          core: { screen_name: 'X', name: 'X', created_at_ms: 1171982154000 },
          relationship_counts: { followers: 5, following: 1 },
          tweet_counts: { tweets: 2 },
        },
      },
    });
    const user = await new XApi(client).getUser('@X');

    expect(user).toMatchObject({ id: '783214', username: 'X', followers: 5, tweets: 2 });
    expect(calls[0]).toMatchObject({ name: 'UserByScreenName', vars: { screenName: 'X' } });
  });
});
