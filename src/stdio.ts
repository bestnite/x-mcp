#!/usr/bin/env node
/**
 * stdio 入口：给 MCPHub / Claude Desktop 这类「起一个进程、用 stdin/stdout 说话」的宿主用。
 *
 * 与 index.ts 的区别只有传输方式：
 * - 这里绝不往 stdout 写日志（会污染 JSON-RPC 流），一切日志走 stderr；
 * - 配置优先读环境变量（容器里没有 .env），见 config.ts 的 X_AUTH_TOKEN / X_CSRF_TOKEN。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createServer } from './mcp/server.js';
import { XApi } from './x/api.js';
import { XClient } from './x/client.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new XClient(config);
  const api = new XApi(client);
  const server = createServer(api);

  await server.connect(new StdioServerTransport());
  console.error('x-mcp: stdio transport ready');

  // 预热不阻塞第一条请求；失败只提示，首次调用会自行重建
  void client
    .warmUp()
    .then(({ operations, transactionReady }) => {
      console.error(
        `x-mcp: warm-up ${operations} operations, signer ${transactionReady ? 'ready' : 'NOT ready'}`,
      );
    })
    .catch((error: unknown) => {
      console.error('x-mcp: warm-up failed:', error instanceof Error ? error.message : String(error));
    });
}

main().catch((error: unknown) => {
  console.error('x-mcp: fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
