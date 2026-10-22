/**
 * 六个只读能力的高层封装。
 *
 * 端点选择说明（2026-10 实测）：
 * - 用户 / 推文 / 搜索 / 详情 → internal GraphQL，queryId 由 operations 表动态提供；
 * - 首页时间线 → X 已不再提供 HomeTimeline 这个 GraphQL operation，
 *   但老 v2 REST `/i/api/2/timeline/home.json` 仍然存活（返回 globalObjects 结构）；
 * - 趋势 → v1.1 `/i/api/1.1/trends/place.json` 也意外存活
 *   （其它 v1.1 端点如 account/settings.json 早已 404 code 34）。
 */
import type { XClient } from './client.js';
import type { TweetPage, Tweet, Trend, User } from './parse.js';
import { parseHomeTimeline, parseTimelineInstructions, parseTrendsRest, parseTweetResult, parseUserResult } from './parse.js';
import { XError } from './auth.js';

/** GraphQL 单页上限；超过这个数 X 会截断或报错。 */
const MAX_PAGE = 40;

export type SearchProduct = 'Latest' | 'Top' | 'Media';

export class XApi {
  constructor(private readonly client: XClient) {}

  async getUser(username: string): Promise<User> {
    const clean = username.replace(/^@/, '');
    const data = await this.client.graphql<{ user?: { result?: unknown } }>('UserByScreenName', {
      screen_name: clean,
      withSafetyModeUserFields: true,
    });
    const user = parseUserResult(data?.user?.result);
    if (!user) throw new XError(`User @${clean} not found or the response shape changed.`);
    return user;
  }

  async getUserTweets(usernameOrId: string, limit = 20): Promise<TweetPage> {
    const userId = /^\d+$/.test(usernameOrId)
      ? usernameOrId
      : (await this.getUser(usernameOrId)).id;

    const data = await this.client.graphql<{
      user?: {
        result?: {
          /** 2026 版：instructions 在 result.timeline.timeline 下 */
          timeline?: { timeline?: { instructions?: unknown } };
          /** 旧版路径 */
          timeline_v2?: { timeline?: { instructions?: unknown } };
        };
      };
    }>('UserTweets', {
      userId,
      count: Math.min(limit, MAX_PAGE),
      includePromotedContent: true,
      withClientEventToken: false,
      withBirdwatchNotes: false,
      withVoice: true,
      withV2Timeline: true,
    });

    const userResult = data?.user?.result;
    const instructions =
      userResult?.timeline?.timeline?.instructions ?? userResult?.timeline_v2?.timeline?.instructions;
    if (!instructions) throw new XError('UserTweets returned no timeline (protected account or changed shape).');
    const page = parseTimelineInstructions(instructions);
    return { tweets: page.tweets.slice(0, limit), nextCursor: page.nextCursor };
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
    const data = await this.client.graphql<{
      search_by_raw_query?: { search_timeline?: { timeline?: { instructions?: unknown } } };
    }>('SearchTimeline', {
      rawQuery: query,
      count: Math.min(limit, MAX_PAGE),
      product,
      querySource: 'typed_query',
    });

    const instructions = data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
    if (!instructions) throw new XError('SearchTimeline returned no timeline.');
    const page = parseTimelineInstructions(instructions);
    return { tweets: page.tweets.slice(0, limit), nextCursor: page.nextCursor };
  }

  /** 推文详情：焦点推文 + 其下的回复/引用会话。 */
  async getTweetDetail(tweetId: string, limit = 20): Promise<{ tweet: Tweet | null; replies: Tweet[] }> {
    const data = await this.client.graphql<{
      threaded_conversation_with_injections_v2?: { instructions?: unknown };
    }>('TweetDetail', {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
      withV2Timeline: true,
    });

    const instructions = data?.threaded_conversation_with_injections_v2?.instructions;
    if (!instructions) throw new XError('TweetDetail returned no conversation.');
    const page = parseTimelineInstructions(instructions);

    const tweet = page.tweets.find((t) => t.id === tweetId) ?? page.tweets[0] ?? null;
    const replies = page.tweets.filter((t) => t.id !== tweet?.id).slice(0, limit);
    return { tweet, replies };
  }

  /** 趋势。woeid=1 为全球，中国为 23424781。 */
  async getTrends(woeid = 1): Promise<Trend[]> {
    const payload = await this.client.rest<unknown>('/1.1/trends/place.json', { id: woeid });
    return parseTrendsRest(payload);
  }
}

export { parseTweetResult };
