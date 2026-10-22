/**
 * 运行配置。
 *
 * 凭证只从文件读取（.env 或显式路径），不接受命令行参数——
 * 命令行会进 shell 历史、进程列表和 agent 日志。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { XError } from './x/auth.js';

export interface SessionCookies {
  authToken: string;
  ct0: string;
  twid?: string;
  lang: string;
}

export interface Config {
  cookies: SessionCookies;
  host: string;
  port: number;
  /** operations 表的缓存时长；过期后从 main.js 重新提取。 */
  operationsTtlMs: number;
}

/** 极简 .env 解析：KEY=VALUE，忽略注释与空行，不处理引号转义。 */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.X_COOKIE_FILE ?? resolve(process.cwd(), '.env');
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(file);
  } catch {
    // 没有 .env 时允许完全走环境变量
  }

  const pick = (key: string): string | undefined => env[key] ?? fromFile[key];

  const authToken = pick('auth_token') ?? pick('X_AUTH_TOKEN');
  const ct0 = pick('ct0') ?? pick('X_CSRF_TOKEN');
  if (!authToken || !ct0) {
    throw new XError(
      'auth_missing',
      `No X session configured: auth_token and ct0 are missing from ${file} (and from X_AUTH_TOKEN / X_CSRF_TOKEN).`,
    );
  }

  return {
    cookies: {
      authToken,
      ct0,
      twid: pick('twid'),
      lang: pick('lang') ?? 'en',
    },
    host: pick('X_MCP_HOST') ?? '127.0.0.1',
    port: Number(pick('X_MCP_PORT') ?? 8787),
    operationsTtlMs: Number(pick('X_OPERATIONS_TTL_MS') ?? 6 * 60 * 60 * 1000),
  };
}
