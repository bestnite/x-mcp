/**
 * MCP 工具层：把 XApi 的六个只读方法暴露给 agent。
 *
 * 设计上刻意只做读：QuaX/Squawker 这类客户端本身也不提供写操作，
 * 写接口没有经过验证的参考实现，不做半成品。
 */
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { XApi } from '../x/api.js';
import { XError, XRateLimitError, type XErrorCode } from '../x/auth.js';

// 版本号只有 package.json 一处，避免发版后 serverInfo 还报旧版本。
// dist/mcp/server.js 与 src/mcp/server.ts 到包根都是两级，发布后该文件一定在包内。
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/**
 * 异常 → 工具错误。调用方是 agent，所以每条错误都回答三件事：
 * 什么意思、谁能修、要不要重试。agent 会把这段转述给用户。
 */
const HINTS: Record<
  XErrorCode,
  { meaning: string; action: string; retryable: boolean }
> = {
  auth_missing: {
    meaning: 'The MCP server has no X session configured at all.',
    action:
      "The user must add auth_token and ct0 to the server's .env (mode 600) and restart it. Nothing the agent can do will fix this.",
    retryable: false,
  },
  auth_expired: {
    meaning:
      'The stored X session cookie is no longer accepted. X does not refresh auth_token in responses, so this cannot self-heal.',
    action:
      'Ask the user to: log in to x.com in a browser, open DevTools → Application → Cookies → x.com, copy auth_token and ct0, replace both values in the server\'s .env, then restart the server.',
    retryable: false,
  },
  auth_csrf: {
    meaning:
      'auth_token and ct0 no longer belong to the same session — usually only one of the two was updated.',
    action:
      'Ask the user to copy BOTH auth_token and ct0 from the same browser session and replace both in .env, then restart the server.',
    retryable: false,
  },
  auth_restricted: {
    meaning: 'The account is authenticated but X is refusing the request (locked, suspended, or permission denied).',
    action:
      'The user must resolve it on x.com (unlock via email/SMS, or appeal a suspension). Replacing cookies will not help.',
    retryable: false,
  },
  rate_limited: {
    meaning: 'X rate-limited this account for this endpoint.',
    action: 'Wait until the reset time shown above, then retry. Retrying earlier extends the block.',
    retryable: true,
  },
  query_stale: {
    meaning:
      "The queryId was refreshed and the request still failed. X most likely renamed or removed the operation the server depends on.",
    action:
      'This needs a maintainer: check docs/endpoints.md and docs/reverse-engineering.md. Retrying or changing arguments will not help.',
    retryable: false,
  },
  signer_broken: {
    meaning: 'The x-client-transaction-id signer could not be rebuilt from x.com — X probably changed its signing chain.',
    action:
      'This needs a maintainer: see docs/reverse-engineering.md §7 (maintenance playbook). Not an argument or credential problem.',
    retryable: false,
  },
  not_found: {
    meaning: 'The target (user or post) does not exist, was deleted, or is not visible to this account.',
    action: 'Double-check the handle or post id. Try a different one; do not retry the same value.',
    retryable: false,
  },
  upstream: {
    meaning: 'A transient network or upstream failure, or an unexpected response shape.',
    action: 'Retrying once is reasonable. If it persists, report it with this message.',
    retryable: true,
  },
};

function failure(error: unknown) {
  if (!(error instanceof XError)) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `[err.unexpected]\n${String(error)}\n\nMeaning: the server hit an error it does not classify.\nAction: report this message as-is.`,
        },
      ],
    };
  }

  const hint = HINTS[error.code];
  const reset =
    error instanceof XRateLimitError && error.resetAt ? `\nRate limit resets at: ${error.resetAt.toISOString()}` : '';

  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: [
          `[err.${error.code}] ${error.message}`,
          '',
          `Meaning: ${hint.meaning}`,
          `Action: ${hint.action}`,
          `Retryable: ${hint.retryable ? 'yes' : 'no — do not call this tool again until the action above is done'}`,
        ].join('\n') + reset,
      },
    ],
  };
}

export function createServer(api: XApi): McpServer {
  const server = new McpServer({
    name: 'x-mcp',
    version: pkg.version,
  });

  server.registerTool(
    'x_auth_status',
    {
      title: 'Check the X session',
      description:
        "Health check for the configured X session: reports whether the stored cookies still work, and if not, what the user has to do. Call this first when another tool fails — it tells 'cookies expired' apart from 'endpoint broke'.",
      inputSchema: {},
    },
    async () => {
      try {
        const status = await api.checkAuth();
        if (status.ok) {
          return json({
            ok: true,
            authenticated: true,
            message: 'The stored X session is valid; read tools should work.',
          });
        }
        return failure(new XError(status.code as XErrorCode, status.message ?? 'Session check failed.'));
      } catch (error) {
        return failure(error);
      }
    },
  );

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
        'Fetch a single post plus the replies/conversation shown under it. Pass the numeric post id (the trailing number of a status URL). The response carries nextCursor when more replies exist — pass it back as cursor to read the next page; paged responses have tweet=null and contain only replies.',
      inputSchema: {
        id: z.string().describe('Numeric post id'),
        limit: z.number().int().min(1).max(40).default(20).describe('How many replies to return per page (1-40)'),
        cursor: z
          .string()
          .optional()
          .describe('nextCursor from a previous call, to read further replies'),
      },
    },
    async ({ id, limit, cursor }) => {
      try {
        return json(await api.getTweetDetail(id, limit, cursor));
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
