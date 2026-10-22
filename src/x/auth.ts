/**
 * X 内部接口的请求头与错误类型。
 *
 * bearer 是网页端的公开常量（不是密钥），从任何客户端源码 grep `AAAAAAAAAAAAAAAAAAAAA` 即可；
 * 真正会过期的是 cookie，真正会变的是 x-client-transaction-id 与 queryId。
 */
import type { SessionCookies } from '../config.js';

/** 网页端公开 bearer，X 很少换。 */
export const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const GRAPHQL_BASE = 'https://x.com/i/api/graphql';
/** 相对路径前缀，调用方补 host。 */
export const REST_BASE = '/i/api';

export function cookieHeader(cookies: SessionCookies): string {
  const parts = [`auth_token=${cookies.authToken}`, `ct0=${cookies.ct0}`, `lang=${cookies.lang}`];
  if (cookies.twid) parts.push(`twid=${cookies.twid}`);
  return parts.join('; ');
}

/** 抓网页资源（首页、main.js）用的头：不带 authorization，行为最接近浏览器。 */
export function webHeaders(cookies: SessionCookies): Record<string, string> {
  return {
    'user-agent': USER_AGENT,
    'accept-language': 'en-US,en;q=0.9',
    cookie: cookieHeader(cookies),
  };
}

/** 调内部 API 用的头。transactionId 由调用方补。 */
export function apiHeaders(cookies: SessionCookies, transactionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...webHeaders(cookies),
    authorization: `Bearer ${WEB_BEARER}`,
    'x-csrf-token': cookies.ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': cookies.lang,
    'content-type': 'application/json',
    accept: '*/*',
    referer: 'https://x.com/',
  };
  if (transactionId) headers['x-client-transaction-id'] = transactionId;
  return headers;
}

export class XError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'XError';
  }
}

/** cookie 失效或账号被限制：重试没有意义。 */
export class XAuthError extends XError {
  constructor(message: string, status?: number) {
    super(message, status, 'AUTH');
    this.name = 'XAuthError';
  }
}

/** 端点/参数过期：通常是 queryId 轮换或 features 不匹配。 */
export class XGraphqlError extends XError {
  constructor(message: string, status?: number) {
    super(message, status, 'GRAPHQL');
    this.name = 'XGraphqlError';
  }
}

export class XRateLimitError extends XError {
  constructor(message: string, readonly resetAt?: Date) {
    super(message, 429, 'RATE_LIMIT');
    this.name = 'XRateLimitError';
  }
}
