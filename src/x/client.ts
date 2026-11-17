/**
 * X 内部 API 客户端：GraphQL（页面发现 queryId，不需要签名头）+ 少量仍存活的 REST 端点。
 *
 * 只有三样东西会过期，失效信号各不相同：
 * - cookie（auth_token/ct0）→ 401/403，或页面变成登录墙
 * - queryId → 404 / 422 GRAPHQL_VALIDATION_FAILED
 * - 变量模板（页面自带的 relay 开关）→ 422，与 queryId 过期长得一样
 *
 * 所以 404/422 不直接判死：重挖一次 operation 再试一次，两次都不行才报 query_stale。
 * 报错信息里带上「哪一步、哪条 operation」，agent 才能把「换 cookie」和「找维护者」分开。
 */
import type { Config } from '../config.js';
import {
  GRAPHQL_BASE,
  REST_BASE,
  XAuthError,
  XError,
  XGraphqlError,
  XRateLimitError,
  apiHeaders,
  extractXCode,
  webHeaders,
  type XErrorCode,
} from './auth.js';
import { OperationsRegistry, type Operation, type PageSpec } from './operations.js';

type Failure = {
  ok: false;
  kind: 'auth' | 'stale' | 'rate' | 'error';
  status: number;
  body: string;
  /** X 错误体里的数字 code，用来区分同一状态码下的不同原因（353=csrf 不匹配等） */
  xCode?: number;
  resetAt?: Date;
};

type Attempt<T> = { ok: true; data: T } | Failure;

export class XClient {
  readonly operations: OperationsRegistry;

  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.operations = new OperationsRegistry(config.cookies, config.operationsTtlMs, fetcher);
  }

  /** 启动时的探活：只确认 cookie 还能用，operation 在第一次调用时按页发现。 */
  async warmUp(): Promise<{ authenticated: boolean; message: string }> {
    const probe = await this.probeSession();
    return probe.ok
      ? { authenticated: true, message: 'the stored session is valid' }
      : { authenticated: false, message: probe.message };
  }

  // --- 会话探测 ---

  /**
   * 只检查 cookie 是否还有效：请求 x.com/home（不需要任何 operation）。
   *
   * 判断依据是状态码而不是内容：已登录时 /home 直接 200，
   * 未登录时 X 回 307 跳到 /i/jf/onboarding/... 登录页——跟随后再看内容会误判成"有效"。
   */
  async probeSession(): Promise<{ ok: true } | { ok: false; code: XErrorCode; message: string }> {
    try {
      const res = await this.fetcher('https://x.com/home', {
        headers: webHeaders(this.config.cookies),
        redirect: 'manual',
      });

      if (res.status === 200) return { ok: true };

      if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
        const location = res.headers.get('location') ?? '';
        return {
          ok: false,
          code: 'auth_expired',
          message: `x.com redirected /home to ${location || 'a login page'} instead of serving the timeline — the session cookies are no longer valid.`,
        };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          code: 'auth_expired',
          message: `x.com returned HTTP ${res.status} for /home — the session cookies are no longer valid.`,
        };
      }
      return {
        ok: false,
        code: 'upstream',
        message: `x.com returned HTTP ${res.status} for /home.`,
      };
    } catch (error) {
      return {
        ok: false,
        code: 'upstream',
        message: `Could not reach x.com: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 数字用户 id → handle：`/i/user/<id>` 会 302 到 `/<handle>`。
   * 用户时间线那条 operation 只接受 screenName，所以数字入参要先换一次。
   */
  async resolveUsername(userId: string): Promise<string> {
    const url = `https://x.com/i/user/${userId}`;
    let res: Response;
    try {
      res = await this.fetcher(url, { headers: webHeaders(this.config.cookies), redirect: 'follow' });
    } catch (error) {
      throw new XError(
        'upstream',
        `Could not resolve the user id ${userId} to a handle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new XAuthError('auth_expired', `${url} returned HTTP ${res.status}: the session cookie is no longer accepted.`, res.status);
    }
    if (res.status === 404) {
      throw new XError('not_found', `No X account has the id ${userId}.`, 404);
    }
    if (!res.ok) {
      throw new XError('upstream', `${url} returned HTTP ${res.status}.`, res.status);
    }

    const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(new URL(res.url || url).pathname);
    if (!match?.[1]) {
      throw new XError('not_found', `The id ${userId} did not resolve to a handle (landed on ${res.url || url}).`);
    }
    return match[1];
  }

  // --- GraphQL ---

  /**
   * 调一条 GraphQL operation。
   *
   * `page` 是这条 operation 的发现来源（搜索页 / 个人页 / 状态页），
   * `variables` 只放调用方关心的键，页面自带的 relay 开关原样保留。
   */
  async graphql<T>(operationName: string, page: PageSpec, variables: Record<string, unknown>): Promise<T> {
    const first = await this.attemptGraphql<T>(operationName, page, variables);
    if (first.ok) return first.data;
    // 认证、限流、其它错误直接抛；只有 stale（404/422）才值得重挖重试一次
    if (first.kind !== 'stale') throw this.toError(first, operationName);

    const refreshed = await this.operations.refresh(operationName, page);
    const retried = await this.attemptGraphql<T>(operationName, page, variables, refreshed);
    if (!retried.ok) {
      throw this.toError(retried, operationName, 'after rediscovering the operation');
    }
    return retried.data;
  }

  /** 把失败结果翻译成带语义的异常。返回而非抛出，避免依赖 never 的控制流窄化。 */
  private toError(attempt: Attempt<unknown>, what: string, context?: string): XError {
    if (attempt.ok) return new XGraphqlError('upstream', `${what} unexpectedly succeeded`);
    const suffix = context ? ` (${context})` : '';

    switch (attempt.kind) {
      case 'auth': {
        if (attempt.status === 401) {
          return new XAuthError(
            'auth_expired',
            `${what} returned HTTP 401${suffix}: the session cookie is no longer accepted.`,
            401,
          );
        }
        if (attempt.xCode === 353) {
          return new XAuthError(
            'auth_csrf',
            `${what} returned HTTP 403${suffix}: csrf token (ct0) does not match auth_token.`,
            403,
          );
        }
        const reason =
          attempt.xCode === 326
            ? 'the account is temporarily locked'
            : attempt.xCode === 64
              ? 'the account is suspended'
              : 'the account is not allowed to perform this request';
        return new XAuthError('auth_restricted', `${what} returned HTTP 403${suffix}: ${reason}.`, 403);
      }
      case 'rate':
        return new XRateLimitError(
          `${what} hit the rate limit${attempt.resetAt ? `; resets at ${attempt.resetAt.toISOString()}` : ''}.`,
          attempt.resetAt,
        );
      case 'stale':
        return new XGraphqlError(
          'query_stale',
          `${what} returned HTTP ${attempt.status}${suffix} even after rediscovering its queryId from the page: ${attempt.body.slice(0, 200)}`,
          attempt.status,
        );
      default:
        return new XError(
          'upstream',
          `${what} returned HTTP ${attempt.status}${suffix}: ${attempt.body.slice(0, 200)}`,
          attempt.status,
        );
    }
  }

  private async attemptGraphql<T>(
    operationName: string,
    page: PageSpec,
    variables: Record<string, unknown>,
    known?: Operation,
  ): Promise<Attempt<T>> {
    const operation = known ?? (await this.operations.get(operationName, page));

    // 页面模板在前，调用方的值覆盖同名键：模板里的 rawQuery/screenName 只是页面自己的参数
    const merged = { ...operation.variables, ...variables };
    const query = new URLSearchParams({ variables: JSON.stringify(merged) });
    const path = `${GRAPHQL_BASE}/${operation.queryId}/${operation.operationName}`;

    let res: Response;
    try {
      res = await this.fetcher(`${path}?${query}`, { headers: apiHeaders(this.config.cookies) });
    } catch (error) {
      throw new XError(
        'upstream',
        `Could not reach x.com for ${operationName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!res.ok) return classify(res, await res.text().catch(() => ''));

    const body = await res.text().catch(() => '');
    let json: { data?: T; errors?: { message?: string }[] };
    try {
      json = JSON.parse(body) as { data?: T; errors?: { message?: string }[] };
    } catch {
      return { ok: false, kind: 'error', status: res.status, body: `response was not JSON: ${body.slice(0, 120)}` };
    }
    if (!json.data) {
      const reason = json.errors?.[0]?.message ?? 'response had no data payload';
      return { ok: false, kind: 'error', status: res.status, body: reason };
    }
    return { ok: true, data: json.data };
  }

  // --- REST（v2 / v1.1：实测不需要签名，也不需要 operation） ---

  async rest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`https://x.com${REST_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    let res: Response;
    try {
      res = await this.fetcher(url.toString(), { headers: apiHeaders(this.config.cookies) });
    } catch (error) {
      throw new XError(
        'upstream',
        `Could not reach x.com for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!res.ok) {
      const attempt = classify(res, await res.text().catch(() => ''));
      throw this.toError(attempt, path);
    }
    return (await res.json()) as T;
  }
}

function classify(res: Response, body: string): Failure {
  const status = res.status;
  if (status === 401 || status === 403) {
    return { ok: false, kind: 'auth', status, body, xCode: extractXCode(body) };
  }
  if (status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    return {
      ok: false,
      kind: 'rate',
      status,
      body,
      xCode: extractXCode(body),
      resetAt: reset ? new Date(Number(reset) * 1000) : undefined,
    };
  }
  if (status === 404 || status === 422) {
    return { ok: false, kind: 'stale', status, body, xCode: extractXCode(body) };
  }
  return { ok: false, kind: 'error', status, body, xCode: extractXCode(body) };
}
