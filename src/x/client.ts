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
} from './auth.js';
import { OperationsRegistry } from './operations.js';

type Failure = {
  ok: false;
  kind: 'auth' | 'stale' | 'rate' | 'error';
  status: number;
  body: string;
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
          throw new XError(`Could not fetch x.com to build the signer: ${error.message}`, error.statusCode);
        }
        if (error instanceof ClientTransactionIdError) {
          throw new XError(`The transaction-id signer broke: ${error.message}`);
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
    if (attempt.ok) return new XGraphqlError(`${what} unexpectedly succeeded`);
    const suffix = context ? ` (${context})` : '';
    switch (attempt.kind) {
      case 'auth':
        return new XAuthError(
          `${what} returned HTTP ${attempt.status}${suffix}. The auth_token/ct0 cookies are expired or the account is restricted.`,
          attempt.status,
        );
      case 'rate':
        return new XRateLimitError(
          `${what} hit the rate limit${attempt.resetAt ? `; resets at ${attempt.resetAt.toISOString()}` : ''}.`,
          attempt.resetAt,
        );
      default:
        return new XGraphqlError(
          `${what} returned HTTP ${attempt.status}${suffix}: ${attempt.body.slice(0, 240)}`,
          attempt.status,
        );
    }
  }

  private async attemptGraphql<T>(
    operationName: string,
    variables: Record<string, unknown>,
  ): Promise<Attempt<T>> {
    const op = await this.operations.get(operationName);
    const tx = await this.getTransaction();
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

    const tx = await this.getTransaction();
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
  if (status === 401 || status === 403) return { ok: false, kind: 'auth', status, body };
  if (status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    return {
      ok: false,
      kind: 'rate',
      status,
      body,
      resetAt: reset ? new Date(Number(reset) * 1000) : undefined,
    };
  }
  if (status === 404 || status === 422) return { ok: false, kind: 'stale', status, body };
  return { ok: false, kind: 'error', status, body };
}
