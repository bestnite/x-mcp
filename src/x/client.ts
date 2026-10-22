/**
 * X 内部 API 客户端：GraphQL（带签名）+ 少量仍存活的 REST 端点。
 *
 * 三个会过期的依赖，失效信号各不相同：
 * - cookie（auth_token/ct0）→ 401/403
 * - queryId → 404 / 422 GRAPHQL_VALIDATION_FAILED
 * - 签名链（key 或算法）→ 404，而且看起来和 queryId 过期一模一样
 *
 * 所以 404 不能直接判死：先刷新 operations 重试，再重建签名器重试，
 * 两次都不行才报错，报错信息里带上是哪一步失败的。
 */
import type { Config } from '../config.js';
import { ClientTransaction, ClientTransactionIdError, SourceFetchError } from '../tid/index.js';
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
import { OperationsRegistry } from './operations.js';

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
  private transaction: ClientTransaction | null = null;
  private transactionLoading: Promise<ClientTransaction> | null = null;
  readonly operations: OperationsRegistry;

  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.operations = new OperationsRegistry(config.cookies, config.operationsTtlMs, fetcher);
  }

  /** 预热签名器与 operations 表；失败只记录，不阻塞启动。 */
  async warmUp(): Promise<{ operations: number; transactionReady: boolean }> {
    const [ops, tx] = await Promise.allSettled([
      this.operations.refresh(true),
      this.getTransaction(),
    ]);
    return {
      operations: this.operations.size,
      transactionReady: tx.status === 'fulfilled' && ops.status === 'fulfilled',
    };
  }

  // --- 签名器 ---

  private async getTransaction(): Promise<ClientTransaction> {
    if (this.transaction) return this.transaction;
    if (this.transactionLoading) return this.transactionLoading;

    this.transactionLoading = (async () => {
      try {
        const tx = await ClientTransaction.initialize();
        this.transaction = tx;
        return tx;
      } catch (error) {
        if (error instanceof SourceFetchError) {
          // cookie 失效时连签名器都建不起来：这在用户看来是「登录过期」，不是「代码坏了」
          if (error.statusCode === 401 || error.statusCode === 403) {
            throw new XAuthError(
              'auth_expired',
              `x.com rejected the session while building the signer (HTTP ${error.statusCode}) — the cookies are no longer valid.`,
              error.statusCode,
            );
          }
          throw new XError(
            'signer_broken',
            `Could not fetch x.com to build the signer: ${error.message}`,
            error.statusCode,
          );
        }
        if (error instanceof ClientTransactionIdError) {
          throw new XError('signer_broken', `The transaction-id signer broke: ${error.message}`);
        }
        throw error;
      }
    })();

    try {
      return await this.transactionLoading;
    } finally {
      this.transactionLoading = null;
    }
  }

  /**
   * 准备阶段（取 queryId、建签名器）失败时，判断是不是 cookie 失效导致的。
   * 是的话把「页面结构变了」改写成 auth_expired——这个区别决定 agent 让用户换 cookie 还是找维护者。
   */
  private async enrichAuthError(error: unknown): Promise<unknown> {
    if (error instanceof XAuthError) return error;
    if (!(error instanceof XError)) return error;
    if (error.code === 'auth_expired' || error.code === 'auth_csrf') return error;

    const probe = await this.probeSession().catch(() => null);
    if (probe && !probe.ok && probe.code === 'auth_expired') {
      return new XAuthError(
        'auth_expired',
        `${probe.message} The request could not even be prepared: ${error.message}`,
        401,
      );
    }
    return error;
  }

  // --- 会话探测 ---

  /**
   * 只检查 cookie 是否还有效：请求 x.com/home（不需要签名器，不需要 tid）。
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

  // --- GraphQL ---

  async graphql<T>(operationName: string, variables: Record<string, unknown>): Promise<T> {
    const first = await this.attemptGraphql<T>(operationName, variables);
    if (first.ok) return first.data;
    // 认证、限流、其它错误直接抛；只有 stale（404/422）才值得换 queryId/签名器重试
    if (first.kind !== 'stale') throw this.toError(first, operationName);

    // 走到这里说明是 stale（404/422）：先刷新 queryId 表
    try {
      await this.operations.refresh(true);
      const retried = await this.attemptGraphql<T>(operationName, variables);
      if (!retried.ok) throw this.toError(retried, operationName);
      return retried.data;
    } catch (error) {
      if (error instanceof XAuthError || error instanceof XRateLimitError) throw error;
      // 刷新本身失败或重试仍然 stale：继续换签名器
    }

    // queryId 没问题，那就是签名链断了（key 轮换）
    this.transaction = null;
    const third = await this.attemptGraphql<T>(operationName, variables);
    if (!third.ok) {
      throw this.toError(third, operationName, 'after refreshing both the queryId table and the signer');
    }
    return third.data;
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
          `${what} returned HTTP ${attempt.status}${suffix} even after refreshing the queryId table and rebuilding the signer: ${attempt.body.slice(0, 200)}`,
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
    variables: Record<string, unknown>,
  ): Promise<Attempt<T>> {
    // operations / 签名器都依赖 x.com 的页面：cookie 失效时它们会以"结构变了"的形式失败。
    // 准备阶段的异常先探一次会话，把归因校正到认证上，否则 agent 会以为是代码坏了。
    let op;
    try {
      op = await this.operations.get(operationName);
    } catch (error) {
      throw await this.enrichAuthError(error);
    }

    let tx;
    try {
      tx = await this.getTransaction();
    } catch (error) {
      throw await this.enrichAuthError(error);
    }

    const path = `/i/api/graphql/${op.queryId}/${op.operationName}`;

    const query = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(op.features),
    });
    if (op.fieldToggles.length > 0) {
      query.set(
        'fieldToggles',
        JSON.stringify(Object.fromEntries(op.fieldToggles.map((name) => [name, true]))),
      );
    }

    const res = await this.fetcher(`${GRAPHQL_BASE}/${op.queryId}/${op.operationName}?${query}`, {
      headers: apiHeaders(this.config.cookies, tx.generateTransactionId('GET', path)),
    });

    if (!res.ok) return classify(res, await res.text().catch(() => ''));
    const json = (await res.json()) as { data?: T };
    if (!json.data) {
      return { ok: false, kind: 'error', status: res.status, body: 'response had no data payload' };
    }
    return { ok: true, data: json.data };
  }

  // --- REST（v1.1 / v2：实测不需要签名，但仍带上） ---

  async rest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`https://x.com${REST_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    let tx;
    try {
      tx = await this.getTransaction();
    } catch (error) {
      throw await this.enrichAuthError(error);
    }
    const res = await this.fetcher(url.toString(), {
      headers: apiHeaders(this.config.cookies, tx.generateTransactionId('GET', path)),
    });

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
