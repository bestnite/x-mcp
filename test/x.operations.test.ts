/**
 * 发现层单元测试：不联网，用合成的 x-web 页面片段。
 *
 * 两种记录格式都是实测形状：
 *   A. id:"<queryId>",name:"<Op>",variables:{ <JS 字面量> }   ← 搜索页 / 个人页
 *   B. key:"<queryId>{<JSON>}",name:"<Op>"                    ← 状态页 / 个人页
 */
import { describe, expect, it } from 'vitest';

import { OperationsRegistry, findOperation, isSignedOutPage, literalToJson, pageUrl } from '../src/x/operations.js';
import { loadConfig } from '../src/config.js';

const cookies = loadConfig({ auth_token: 'a', ct0: 'c' } as NodeJS.ProcessEnv).cookies;

const pageA = `
self.__next_f.push([1,"{\\"id\\":\\"-8XxsqZkLb4vxNppbL2swQ\\"}"]);
$x={id:"-8XxsqZkLb4vxNppbL2swQ",name:"SearchByRawQuery",variables:{rawQuery:"deepseek",count:20,cursor:null,withMediaGridTweet:!1,__relay_internal__pv__replydownvoteenabledrelayprovider:!0},fetchKey:void 0,retainForSession:void 0},ssr:!0},$R[9]={i:"#$query##deepseek#{}"}
`;

const pageB = `
$R[43]={kind:0,requestId:3,key:"tCJWJBzmBXpHvd0THltseA{\\"focalTweetId\\":\\"2122631183586738184\\",\\"cursor\\":null,\\"withFocalTweet\\":true}",name:"TweetDetail"},$R[44]={kind:1,requestId:2,key:"a1-8aJWUtaq36odzluaHQA{\\"x\\":1}"}
`;

const pageBResult = `
$R[31]={kind:0,requestId:4,key:"lBWeGst8yjiAMTFhCmNhXw{\\"count\\":20,\\"screenName\\":\\"elonmusk\\",\\"sortByMostLiked\\":null}",name:"UserOriginalsTimeline"},$R[37]={kind:"Result.Ok",value:"{\\"data\\":{\\"user_result_by_screen_name\\":{}}}"}
`;

describe('literalToJson', () => {
  it('把 JS 字面量转成 JSON：裸键、!0/!1、void 0', () => {
    expect(literalToJson('{rawQuery:"x",count:20,ok:!0,off:!1,none:void 0}')).toEqual({
      rawQuery: 'x',
      count: 20,
      ok: true,
      off: false,
      none: null,
    });
  });

  it('$R[n] 反向引用降级成 null，不炸', () => {
    expect(literalToJson('{a:$R[11],b:1}')).toEqual({ a: null, b: 1 });
  });

  it('解析不了时返回 null，由调用方决定是否放弃这条记录', () => {
    expect(literalToJson('{broken:')).toBeNull();
    expect(literalToJson('[]')).toBeNull();
  });
});

describe('findOperation', () => {
  it('读格式 A（id + name + variables）并保留 relay 开关', () => {
    const op = findOperation(pageA, 'SearchByRawQuery')!;
    expect(op.queryId).toBe('-8XxsqZkLb4vxNppbL2swQ');
    expect(op.operationName).toBe('SearchByRawQuery');
    expect(op.variables).toMatchObject({
      rawQuery: 'deepseek',
      count: 20,
      cursor: null,
      withMediaGridTweet: false,
      __relay_internal__pv__replydownvoteenabledrelayprovider: true,
    });
    // fetchKey 属于外层对象，不该被吞进变量
    expect(op.variables).not.toHaveProperty('fetchKey');
  });

  it('读格式 B（key 里内嵌 JSON）', () => {
    const op = findOperation(pageB, 'TweetDetail')!;
    expect(op.queryId).toBe('tCJWJBzmBXpHvd0THltseA');
    expect(op.variables).toEqual({ focalTweetId: '2122631183586738184', cursor: null, withFocalTweet: true });
  });

  it('同一页里 result 记录不会冒充 operation', () => {
    const op = findOperation(pageBResult, 'UserOriginalsTimeline')!;
    expect(op.variables).toEqual({ count: 20, screenName: 'elonmusk', sortByMostLiked: null });
    // value:"{\"data\":…}" 那类记录没有 name，名字对不上就跳过
    expect(findOperation(pageBResult, 'SearchByRawQuery')).toBeNull();
  });

  it('页面里没有这条 operation 时返回 null', () => {
    expect(findOperation(pageA, 'TweetDetail')).toBeNull();
  });
});

describe('pageUrl', () => {
  it('按 operation 的数据来源给出页面', () => {
    expect(pageUrl({ kind: 'search', query: 'a b#c' })).toBe(
      'https://x.com/search?q=a%20b%23c&src=typed_query&f=live',
    );
    expect(pageUrl({ kind: 'profile', username: '@elonmusk' })).toBe('https://x.com/elonmusk');
    expect(pageUrl({ kind: 'status', tweetId: '42' })).toBe('https://x.com/i/web/status/42');
  });
});

function fakeFetch(responses: { status?: number; body?: string; url?: string }[]) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL) => {
    calls.push(String(input));
    const next = responses.shift() ?? { status: 500, body: 'no response queued' };
    const body = next.body ?? '';
    const response = new Response(body, { status: next.status ?? 200 });
    if (next.url) Object.defineProperty(response, 'url', { value: next.url });
    return response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const page = { kind: 'profile' as const, username: 'elonmusk' };

describe('OperationsRegistry', () => {
  it('首次取值抓页面，TTL 内复用缓存', async () => {
    const { fetcher, calls } = fakeFetch([{ body: pageBResult }]);
    let now = 1_000;
    const registry = new OperationsRegistry(cookies, 60_000, fetcher, () => now);

    const first = await registry.get('UserOriginalsTimeline', page);
    now += 59_000;
    const second = await registry.get('UserOriginalsTimeline', page);

    expect(first.queryId).toBe('lBWeGst8yjiAMTFhCmNhXw');
    expect(second).toBe(first);
    expect(calls).toEqual(['https://x.com/elonmusk']);
  });

  it('缓存过期或强制刷新时重新抓', async () => {
    const { fetcher, calls } = fakeFetch([{ body: pageBResult }, { body: pageBResult }, { body: pageBResult }]);
    let now = 0;
    const registry = new OperationsRegistry(cookies, 60_000, fetcher, () => now);

    await registry.get('UserOriginalsTimeline', page);
    now += 61_000;
    await registry.get('UserOriginalsTimeline', page);
    await registry.refresh('UserOriginalsTimeline', page);

    expect(calls).toHaveLength(3);
  });

  it('并发请求共享同一次抓取', async () => {
    const { fetcher, calls } = fakeFetch([{ body: pageBResult }]);
    const registry = new OperationsRegistry(cookies, 60_000, fetcher);

    const [a, b] = await Promise.all([
      registry.get('UserOriginalsTimeline', page),
      registry.get('UserOriginalsTimeline', page),
    ]);

    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it('页面没有这条 operation 时报 query_stale（维护者才能修）', async () => {
    const { fetcher } = fakeFetch([{ body: pageA }]);
    const registry = new OperationsRegistry(cookies, 60_000, fetcher);

    await expect(registry.get('UserOriginalsTimeline', page)).rejects.toMatchObject({ code: 'query_stale' });
  });

  it('登录墙（entry-client-logged-out）报 auth_expired，不报"前端变了"', async () => {
    const { fetcher } = fakeFetch([
      { body: '<script src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-abc.js"></script>' },
    ]);
    const registry = new OperationsRegistry(cookies, 60_000, fetcher);

    await expect(registry.get('SearchByRawQuery', { kind: 'search', query: 'x' })).rejects.toMatchObject({
      code: 'auth_expired',
    });
  });

  it('401 报 auth_expired，404 报 not_found，429 报 rate_limited', async () => {
    const unauthorized = new OperationsRegistry(cookies, 60_000, fakeFetch([{ status: 401 }]).fetcher);
    await expect(unauthorized.get('UserByScreenName', page)).rejects.toMatchObject({ code: 'auth_expired' });

    const missing = new OperationsRegistry(cookies, 60_000, fakeFetch([{ status: 404 }]).fetcher);
    await expect(missing.get('UserByScreenName', page)).rejects.toMatchObject({ code: 'not_found' });

    const limited = new OperationsRegistry(cookies, 60_000, fakeFetch([{ status: 429 }]).fetcher);
    await expect(limited.get('UserByScreenName', page)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('isSignedOutPage 只认登录墙标记', () => {
    expect(isSignedOutPage('…/entry-client-logged-out-abc.js')).toBe(true);
    expect(isSignedOutPage('…/entry-client-DpQAcGwb.js')).toBe(false);
  });
});
