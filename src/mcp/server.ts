/**
 * MCP 工具层：把 XApi 的六个只读方法暴露给 agent。
 *
 * 设计上刻意只做读：QuaX/Squawker 这类客户端本身也不提供写操作，
 * 写接口没有经过验证的参考实现，不做半成品。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { XApi } from '../x/api.js';
import { XAuthError, XError, XRateLimitError } from '../x/auth.js';

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** 异常 → 工具错误：保留可读信息，让 agent 知道是该重试、换凭证还是等。 */
function failure(error: unknown) {
  if (error instanceof XAuthError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Authentication failed: ${error.message}\nThe session cookies (auth_token/ct0) are expired. Refresh them from a logged-in browser.`,
        },
      ],
    };
  }
  if (error instanceof XRateLimitError) {
    const when = error.resetAt ? ` Retry after ${error.resetAt.toISOString()}.` : '';
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Rate limited by X.${when}` }],
    };
  }
  if (error instanceof XError) {
    return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
  }
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Unexpected failure: ${String(error)}` }],
  };
}

export function createServer(api: XApi): McpServer {
  const server = new McpServer({
    name: 'x-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'x_user_lookup',
    {
      title: 'Look up an X user',
      description:
        'Fetch an X (Twitter) profile by @handle: display name, bio, follower/following counts, tweet count, verification, join date, avatar and banner URLs.',
      inputSchema: {
        username: z.string().describe('Handle with or without the leading @'),
      },
    },
    async ({ username }) => {
      try {
        return json(await api.getUser(username));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'x_user_tweets',
    {
      title: 'Recent posts from a user',
      description:
        "List a user's recent posts, newest first. Retweets are included with the original post nested under retweetedTweet. Use x_user_lookup first if you need the profile.",
      inputSchema: {
        username: z.string().describe('Handle (with or without @) or numeric user id'),
        limit: z.number().int().min(1).max(40).default(20).describe('How many posts to return (1-40)'),
      },
    },
    async ({ username, limit }) => {
      try {
        return json(await api.getUserTweets(username, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'x_home_timeline',
    {
      title: 'Home timeline',
      description:
        "The authenticated account's home timeline (the 'For you' feed), newest first. Reflects whatever the account follows.",
      inputSchema: {
        limit: z.number().int().min(1).max(40).default(20).describe('How many posts to return (1-40)'),
      },
    },
    async ({ limit }) => {
      try {
        return json(await api.getHomeTimeline(limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'x_search',
    {
      title: 'Search posts',
      description:
        'Search X posts. Supports X search operators, e.g. "from:user", "lang:en", "min_faves:100", "#tag". product=Latest gives newest results, Top gives relevance-ranked.',
      inputSchema: {
        query: z.string().describe('Search query, X advanced-search operators allowed'),
        product: z.enum(['Latest', 'Top', 'Media']).default('Latest').describe('Result ordering'),
        limit: z.number().int().min(1).max(40).default(20).describe('How many posts to return (1-40)'),
      },
    },
    async ({ query, product, limit }) => {
      try {
        return json(await api.search(query, limit, product));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'x_tweet_detail',
    {
      title: 'Post detail and replies',
      description:
        'Fetch a single post plus the replies/conversation shown under it. Pass the numeric post id (the trailing number of a status URL).',
      inputSchema: {
        id: z.string().describe('Numeric post id'),
        limit: z.number().int().min(1).max(40).default(20).describe('How many replies to return (1-40)'),
      },
    },
    async ({ id, limit }) => {
      try {
        return json(await api.getTweetDetail(id, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'x_trends',
    {
      title: 'Trending topics',
      description:
        'Current trending topics for a location. woeid=1 is worldwide; 23424781 is mainland China; 23424977 is the United States.',
      inputSchema: {
        woeid: z.number().int().positive().default(1).describe('Where-on-earth id (1 = worldwide)'),
      },
    },
    async ({ woeid }) => {
      try {
        return json({ woeid, trends: await api.getTrends(woeid) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
