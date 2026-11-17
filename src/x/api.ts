/**
 * 六个只读能力的高层封装。
 *
 * 端点选择说明（2026-11 实测，x-web 前端）：
 * - 用户 / 用户时间线 / 搜索 / 详情 → internal GraphQL；queryId 与变量模板由对应的
 *   页面在 SSR 文档里给出，见 operations.ts；
 * - 首页时间线 → X 仍不提供 HomeTimeline 这个 GraphQL operation，
 *   老 v2 REST `/i/api/2/timeline/home.json` 继续存活（globalObjects 结构）；
 * - 趋势 → v1.1 `/i/api/1.1/trends/place.json` 也存活（其它 v1.1 端点早已 404 code 34）。
 */
import type { XClient } from './client.js';
import type { PageSpec } from './operations.js';
import type { TweetPage, Tweet, Trend, User } from './parse.js';
import { parseHomeTimeline, parseTimelineInstructions, parseTrendsRest, parseTweetResult, parseUserResult } from './parse.js';
import { XError } from './auth.js';

/** GraphQL 单页上限；超过这个数 X 会截断或报错。 */
const MAX_PAGE = 40;

export type SearchProduct = 'Latest' | 'Top' | 'Media';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const clean = (value: string): string => value.replace(/^@/, '');

export class XApi {
  constructor(private readonly client: XClient) {}

  async getUser(username: string): Promise<User> {
    const screenName = clean(username);
    const page: PageSpec = { kind: 'profile', username: screenName };
    const data = await this.client.graphql<Any>('UserByScreenName', page, {
      screenName,
      withIdentity: true,
    });
    const user = parseUserResult(data?.user_result_by_screen_name?.result ?? data?.user?.result);
    if (!user) {
      throw new XError(
        'not_found',
        `User @${screenName} was not found (it may not exist, be suspended, or the response shape changed).`,
      );
    }
    return user;
  }

  async getUserTweets(usernameOrId: string, limit = 20): Promise<TweetPage> {
    const screenName = await this.resolveUsername(usernameOrId);
    const page: PageSpec = { kind: 'profile', username: screenName };
    const data = await this.client.graphql<Any>('UserOriginalsTimeline', page, {
      screenName,
      count: Math.min(limit, MAX_PAGE),
      cursor: null,
    });

    const result = data?.user_result_by_screen_name?.result;
    const instructions =
      result?.profile_user_originals_timeline?.timeline?.instructions ??
      result?.timeline?.timeline?.instructions ??
      result?.timeline_v2?.timeline?.instructions;
    if (!instructions) {
      throw new XError('upstream', 'UserOriginalsTimeline returned no timeline (protected account or changed shape).');
    }
    const page1 = parseTimelineInstructions(instructions);
    return { tweets: page1.tweets.slice(0, limit), nextCursor: page1.nextCursor };
  }

  async getHomeTimeline(limit = 20): Promise<TweetPage> {
    const payload = await this.client.rest<unknown>('/2/timeline/home.json', {
      count: Math.min(limit, MAX_PAGE),
      include_entities: 'true',
      skip_status: 'true',
      cards_platform: 'Web-12',
      include_cards: '1',
      include_ext_alt_text: 'true',
      include_reply_count: '1',
      tweet_mode: 'full',
    });
    const page = parseHomeTimeline(payload);
    return { tweets: page.tweets.slice(0, limit), nextCursor: page.nextCursor };
  }

  async search(query: string, limit = 20, product: SearchProduct = 'Latest'): Promise<TweetPage> {
    // 发现用的页面就是这次搜索的页面：queryId 与 relay 开关都在它的 SSR 文档里
    const page: PageSpec = { kind: 'search', query };
    const data = await this.client.graphql<Any>('SearchByRawQuery', page, {
      rawQuery: query,
      count: Math.min(limit, MAX_PAGE),
      cursor: null,
      product,
      querySource: 'typed_query',
    });

    const instructions = data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
    if (!instructions) throw new XError('upstream', 'SearchByRawQuery returned no timeline.');
    const parsed = parseTimelineInstructions(instructions);
    return { tweets: parsed.tweets.slice(0, limit), nextCursor: parsed.nextCursor };
  }

  /**
   * 推文详情：焦点推文 + 其下的回复/引用会话，支持翻页。
   *
   * 带 cursor 的页里不再包含焦点推文，只有后续回复，所以此时 tweet 返回 null。
   */
  async getTweetDetail(
    tweetId: string,
    limit = 20,
    cursor?: string,
  ): Promise<{ tweet: Tweet | null; replies: Tweet[]; nextCursor?: string }> {
    const page: PageSpec = { kind: 'status', tweetId };
    const data = await this.client.graphql<Any>('TweetDetail', page, {
      focalTweetId: tweetId,
      ...(cursor ? { cursor } : {}),
      withFocalTweet: true,
    });

    const instructions = data?.threaded_conversation_with_injections_v2?.instructions;
    if (!instructions) throw new XError('upstream', 'TweetDetail returned no conversation.');
    const parsed = parseTimelineInstructions(instructions);

    // 带 cursor 的后续页不含焦点推文，别把第一条回复误当成它
    const tweet = cursor ? null : (parsed.tweets.find((t) => t.id === tweetId) ?? parsed.tweets[0] ?? null);
    const replies = parsed.tweets.filter((t) => t.id !== tweet?.id).slice(0, limit);
    return { tweet, replies, nextCursor: parsed.nextCursor };
  }

  /** 趋势。woeid=1 为全球，中国为 23424781。 */
  async getTrends(woeid = 1): Promise<Trend[]> {
    const payload = await this.client.rest<unknown>('/1.1/trends/place.json', { id: woeid });
    return parseTrendsRest(payload);
  }

  /** cookie 健康检查：agent 可以在调用别的工具前先问「我还能用吗」。 */
  async checkAuth(): Promise<{ ok: boolean; code?: string; message?: string }> {
    return this.client.probeSession();
  }

  /** 数字 id → handle（`/i/user/<id>` 会 302 到 `/<handle>`），handle 原样返回。 */
  private async resolveUsername(usernameOrId: string): Promise<string> {
    const value = clean(usernameOrId);
    if (!/^\d+$/.test(value)) return value;
    return this.client.resolveUsername(value);
  }
}

export { parseTweetResult };
