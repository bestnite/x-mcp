/**
 * queryId / featureSwitches 的自动提取。
 *
 * X 每次改前端都会换一批 queryId（实测约 22 天一次轮换），把 id 写死等于给自己定闹钟。
 * 这里改成启动时从 main.js 的 webpack 模块表里读出来：
 *
 *   {queryId:"BYppgupFFS2yqVmmRNjlsw",operationName:"SearchTimeline",operationType:"query",
 *    metadata:{featureSwitches:[...],fieldToggles:[...]}}
 *
 * main.js 里这类条目目前约 104 条，覆盖全部 internal GraphQL operation。
 */
import type { SessionCookies } from '../config.js';
import { XError, webHeaders } from './auth.js';

export interface Operation {
  queryId: string;
  operationName: string;
  operationType: string;
  features: Record<string, boolean>;
  fieldToggles: string[];
}

const OPERATION_RE =
  /queryId:"([\w-]+)",operationName:"(\w+)",operationType:"(\w+)",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]\}/g;

const MAIN_BUNDLE_RE = /https:\/\/abs\.twimg\.com\/[^"'\s]+\/main\.[\w-]+\.js/g;

const HOME_URL = 'https://x.com/home';

/** 从 bundle 文本里切出所有 operation。 */
export function extractOperations(bundle: string): Map<string, Operation> {
  const ops = new Map<string, Operation>();
  const listOf = (raw: string): string[] =>
    raw.trim() ? [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

  for (const m of bundle.matchAll(OPERATION_RE)) {
    const [, queryId, operationName, operationType, features, toggles] = m;
    ops.set(operationName, {
      queryId,
      operationName,
      operationType,
      // 上游一律置 true：X 的校验只看键是否存在与取值类型，多传不报错
      features: Object.fromEntries(listOf(features).map((name) => [name, true])),
      fieldToggles: listOf(toggles),
    });
  }
  return ops;
}

export class OperationsRegistry {
  private ops = new Map<string, Operation>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly cookies: SessionCookies,
    private readonly ttlMs: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get size(): number {
    return this.ops.size;
  }

  /** 取一个 operation；没加载过或已过期就重取。 */
  async get(name: string): Promise<Operation> {
    if (this.isStale()) await this.refresh();
    const op = this.ops.get(name);
    if (!op) {
      // 可能只是这次没出现在 bundle 里，强制再拉一次
      await this.refresh(true);
      const retried = this.ops.get(name);
      if (!retried) {
        throw new XError(
          `Operation ${name} is not present in the current bundle (${this.ops.size} operations extracted). X may have removed or renamed it.`,
        );
      }
      return retried;
    }
    return op;
  }

  /** queryId 轮换后调用：丢弃缓存并重取。 */
  async refresh(force = false): Promise<void> {
    if (!force && !this.isStale()) return;
    // 并发调用共享同一次加载
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const bundle = await this.fetchMainBundle();
      const ops = extractOperations(bundle);
      if (ops.size === 0) {
        throw new XError('No operations found in main.js — the bundle layout changed.');
      }
      this.ops = ops;
      this.loadedAt = Date.now();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private isStale(): boolean {
    return this.ops.size === 0 || Date.now() - this.loadedAt > this.ttlMs;
  }

  /** 首页 → main.js。两步都必须带 cookie，否则拿到的是登录墙。 */
  private async fetchMainBundle(): Promise<string> {
    const home = await this.fetcher(HOME_URL, {
      headers: webHeaders(this.cookies),
      redirect: 'follow',
    });
    if (!home.ok) {
      throw new XError(`GET ${HOME_URL} returned HTTP ${home.status}`, home.status);
    }
    const html = await home.text();

    const bundleUrl = [...new Set([...html.matchAll(MAIN_BUNDLE_RE)].map((m) => m[0]))][0];
    if (!bundleUrl) {
      throw new XError('Could not find main.js in the x.com homepage — the page layout changed.');
    }

    const bundle = await this.fetcher(bundleUrl, { headers: webHeaders(this.cookies) });
    if (!bundle.ok) {
      throw new XError(`GET ${bundleUrl} returned HTTP ${bundle.status}`, bundle.status);
    }
    return bundle.text();
  }
}
