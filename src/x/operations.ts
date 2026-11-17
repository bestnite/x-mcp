/**
 * GraphQL operation 的发现层：从 x-web 的页面里挖出 queryId 与变量模板。
 *
 * X 在 2026-11 把前端换成了 `x-web` 构建，两件事一起变了：
 *
 * 1. 主页不再有 `main.js`，webpack 模块表那套挖 queryId 的办法失效；
 * 2. 请求不再需要 `x-client-transaction-id` 签名头（实测：带与不带都是 200）。
 *
 * 新构建把每条 relay operation 直接写进页面的 SSR 文档。页面需要哪条数据，
 * 文档里就有那条 operation 的记录，因此「按 operation 找对应页面」即可：
 *
 *   A. id:"<queryId>",name:"<Op>",variables:{ <JS 字面量> }   搜索页 / 个人页
 *   B. key:"<queryId>{<JSON>}",name:"<Op>"                   状态页 / 个人页
 *
 * 变量模板必须原样复用：模板里带着 `__relay_internal__pv__*` 这批 relay 开关，
 * 少一个就 422 GRAPHQL_VALIDATION_FAILED（实测）。调用方只覆盖自己关心的键。
 */
import type { SessionCookies } from '../config.js';
import { XAuthError, XError, XRateLimitError, webHeaders } from './auth.js';

export interface Operation {
  queryId: string;
  operationName: string;
  /** 页面自己发的变量模板，relay 开关在里面。 */
  variables: Record<string, unknown>;
}

/** 哪个页面能提供哪条 operation —— 页面由调用方按参数给出。 */
export type PageSpec =
  | { kind: 'search'; query: string }
  | { kind: 'profile'; username: string }
  | { kind: 'status'; tweetId: string };

export function pageUrl(spec: PageSpec): string {
  switch (spec.kind) {
    case 'search':
      return `https://x.com/search?q=${encodeURIComponent(spec.query)}&src=typed_query&f=live`;
    case 'profile':
      return `https://x.com/${spec.username.replace(/^@/, '')}`;
    case 'status':
      // 不带账号的写法同样会 SSR 出 TweetDetail 那条记录，少一次 UserByScreenName
      return `https://x.com/i/web/status/${spec.tweetId}`;
  }
}

/** 已登录页面与登录墙的判别标记。 */
const SIGNED_OUT_MARKER = 'entry-client-logged-out';

const FORMAT_A =
  /id:"([A-Za-z0-9_-]{10,44})",name:"([A-Za-z][A-Za-z0-9_]*)",variables:/g;

const FORMAT_B = /key:"([A-Za-z0-9_-]{10,44})\{/g;

/**
 * 把页面里的 JS 对象字面量转成 JSON：裸键、`!0`/`!1`、以及 `$R[n]` 反向引用。
 * 引用了别处的槽位无法在本地还原，一律降级成 null（relay 开关不会走这条）。
 */
export function literalToJson(literal: string): Record<string, unknown> | null {
  const text = literal
    .replace(/!0\b/g, 'true')
    .replace(/!1\b/g, 'false')
    .replace(/:void 0\b/g, ':null')
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/:\s*\$R\[\d+\]/g, ':null');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从 `start` 处的 `{` 切出配平的整段对象，字符串里的花括号不算。 */
function sliceObject(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

/**
 * 格式 B 的 payload 是「字符串里的 JSON」：内层引号全部转义，
 * 所以字符串在第一个未转义的引号处结束。
 */
function sliceEscapedString(source: string, start: number): { literal: string; end: number } {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '"') break;
    index += 1;
  }
  return { literal: source.slice(start, index).replace(/\\"/g, '"'), end: index };
}

/** 在页面里找指定 operation；两种记录格式都认。 */
export function findOperation(html: string, operationName: string): Operation | null {
  for (const match of html.matchAll(FORMAT_A)) {
    const [, queryId, name] = match;
    if (name !== operationName || queryId === undefined) continue;
    const open = html.indexOf('{', (match.index ?? 0) + match[0].length);
    if (open < 0) continue;
    const variables = literalToJson(sliceObject(html, open));
    if (!variables) continue;
    return { queryId, operationName, variables };
  }

  for (const match of html.matchAll(FORMAT_B)) {
    const queryId = match[1];
    if (queryId === undefined) continue;
    const open = (match.index ?? 0) + match[0].length - 1;
    const { literal, end } = sliceEscapedString(html, open);
    // 名字紧跟在字符串之后才算这条记录；result:$R[n]=… 那类记录名字为 undefined，会被跳过
    const named = /^,name:"([A-Za-z][A-Za-z0-9_]*)"/.exec(html.slice(end + 1, end + 200));
    if (named?.[1] !== operationName) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(literal);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    return { queryId, operationName, variables: parsed as Record<string, unknown> };
  }

  return null;
}

/** 页面是不是登录墙。登录墙也有这些资源，但没有 operation 记录。 */
export function isSignedOutPage(html: string): boolean {
  return html.includes(SIGNED_OUT_MARKER);
}

export class OperationsRegistry {
  private readonly cache = new Map<string, { operation: Operation; loadedAt: number }>();
  private readonly loading = new Map<string, Promise<Operation>>();

  constructor(
    private readonly cookies: SessionCookies,
    private readonly ttlMs: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.cache.size;
  }

  /** 取一条 operation；缓存过期或 `fresh` 时重新去页面挖。 */
  async get(operationName: string, page: PageSpec, fresh = false): Promise<Operation> {
    const entry = this.cache.get(operationName);
    if (!fresh && entry && this.now() - entry.loadedAt < this.ttlMs) return entry.operation;
    return this.load(operationName, page);
  }

  /** 404/422 之后调用：丢掉缓存重挖一次。 */
  async refresh(operationName: string, page: PageSpec): Promise<Operation> {
    this.cache.delete(operationName);
    return this.load(operationName, page);
  }

  /** 并发调用共享同一次页面抓取。 */
  private load(operationName: string, page: PageSpec): Promise<Operation> {
    const pending = this.loading.get(operationName);
    if (pending) return pending;

    const task = (async () => {
      const html = await this.fetchPage(pageUrl(page), operationName);
      const operation = findOperation(html, operationName);
      if (!operation) {
        if (isSignedOutPage(html)) {
          throw new XAuthError(
            'auth_expired',
            `x.com served the signed-out page instead of ${pageUrl(page)}, so the stored cookies are no longer a live session.`,
          );
        }
        throw new XError(
          'query_stale',
          `${pageUrl(page)} no longer embeds the ${operationName} operation — x-web changed which operations a page ships. See docs/reverse-engineering.md.`,
        );
      }
      this.cache.set(operationName, { operation, loadedAt: this.now() });
      return operation;
    })();

    this.loading.set(operationName, task);
    return task.finally(() => this.loading.delete(operationName));
  }

  private async fetchPage(url: string, operationName: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(url, { headers: webHeaders(this.cookies), redirect: 'follow' });
    } catch (error) {
      throw new XError(
        'upstream',
        `Could not read ${url} to find the ${operationName} operation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new XAuthError(
        'auth_expired',
        `${url} returned HTTP ${response.status}: the session cookie is no longer accepted.`,
        response.status,
      );
    }
    if (response.status === 429) {
      throw new XRateLimitError(`x.com rate-limited the page read for ${url}.`);
    }
    if (response.status === 404) {
      // 个人页 / 状态页 404 一般是「这个账号或这条推文不存在」，比"上游故障"对 agent 更有用
      throw new XError('not_found', `${url} returned HTTP 404: that profile or post does not exist.`, 404);
    }
    if (!response.ok) {
      throw new XError('upstream', `${url} returned HTTP ${response.status}.`, response.status);
    }

    try {
      return await response.text();
    } catch (error) {
      throw new XError(
        'upstream',
        `Could not read the body of ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
