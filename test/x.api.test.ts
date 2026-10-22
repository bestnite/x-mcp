/**
 * XApi 的分页行为。用假的 XClient 记录请求变量——cursor 的变量名是最容易写错的一环
 * （实测 cursorValue 会被忽略，等于没传）。
 */
import { describe, expect, it } from 'vitest';

import { XApi } from '../src/x/api.js';

const tweetNode = (id: string) => ({
  itemContent: {
    tweet_results: {
      result: {
        __typename: 'Tweet',
        rest_id: id,
        legacy: { full_text: `text ${id}`, created_at: 'Wed Oct 21 01:48:35 +0000 2026' },
        core: {
          user_results: {
            result: {
              rest_id: 'u1',
              core: { screen_name: 'someone', name: 'Someone' },
            },
          },
        },
      },
    },
  },
});

const conversation = (ids: string[], cursor = 'NEXT_CURSOR') => ({
  threaded_conversation_with_injections_v2: {
    instructions: [
      {
        type: 'TimelineAddEntries',
        entries: [
          ...ids.map((id) => ({ entryId: `tweet-${id}`, content: tweetNode(id) })),
          { entryId: 'cursor-bottom-1', content: { value: cursor } },
        ],
      },
    ],
  },
});

function fakeClient(response: unknown) {
  const calls: { name: string; vars: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      graphql: async (name: string, vars: Record<string, unknown>) => {
        calls.push({ name, vars });
        return response;
      },
      rest: async () => ({}),
      probeSession: async () => ({ ok: true as const }),
      operations: { size: 0, get: async () => ({}), refresh: async () => {} },
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
