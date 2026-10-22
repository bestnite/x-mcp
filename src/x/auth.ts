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

/**
 * 错误分类，按「谁能修」划分——调用方是 agent，它要把原因和下一步原样转告用户：
 * - auth_*：只有用户能修（重新登录、换 cookie），agent 重试无用。
 * - rate_limited：等时间即可。
 * - query_stale / signer_broken：只有维护者能修（跟版改代码），agent 重试无用。
 * - upstream：网络或 X 侧故障，可重试。
 */
export type XErrorCode =
  /** 配置文件里没有 auth_token / ct0 */
  | 'auth_missing'
  /** 401：cookie 过期或被作废 */
  | 'auth_expired'
  /** 403 + csrf 错误码：ct0 与 auth_token 不匹配 */
  | 'auth_csrf'
  /** 403 其它：账号被锁、被挂起、无权限 */
  | 'auth_restricted'
  | 'rate_limited'
  /** 404/422，且刷新 queryId、重建签名器后仍失败 */
  | 'query_stale'
  /** 签名器构建失败（X 改了前端签名链） */
  | 'signer_broken'
  /** 目标不存在（用户不存在、推文已删） */
  | 'not_found'
  /** 其它上游错误：网络、5xx */
  | 'upstream';

/** X 的错误体里带数字 code，用来区分同一 HTTP 状态下的不同原因。 */
export function extractXCode(body: string): number | undefined {
  const match = /"code"\s*:\s*(\d+)/.exec(body);
  return match ? Number(match[1]) : undefined;
}

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
  readonly code: XErrorCode;
  readonly status?: number;

  constructor(code: XErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'XError';
    this.code = code;
    this.status = status;
  }
}

/** 认证类错误：只有用户能修，agent 重试无用。 */
export class XAuthError extends XError {
  constructor(code: XErrorCode, message: string, status?: number) {
    super(code, message, status);
    this.name = 'XAuthError';
  }
}

/** 端点/参数过期：queryId 轮换或签名链变更，重试与本工具都无法修复。 */
export class XGraphqlError extends XError {
  constructor(code: XErrorCode, message: string, status?: number) {
    super(code, message, status);
    this.name = 'XGraphqlError';
  }
}

export class XRateLimitError extends XError {
  readonly resetAt?: Date;

  constructor(message: string, resetAt?: Date) {
    super('rate_limited', message, 429);
    this.name = 'XRateLimitError';
    this.resetAt = resetAt;
  }
}
