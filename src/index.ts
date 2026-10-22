/**
 * 入口：把 MCP server 挂在一个 streamable HTTP 端点上。
 *
 * 无状态模式（sessionIdGenerator: undefined）：每个请求自带完整上下文，
 * 适合放在网关后面被多个客户端共用，不需要维护会话表。
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loadConfig } from './config.js';
import { createServer } from './mcp/server.js';
import { XApi } from './x/api.js';
import { XClient } from './x/client.js';

const MCP_PATH = '/mcp';

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new XClient(config);
  const api = new XApi(client);

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      return respondJson(res, 200, {
        status: 'ok',
        operations: client.operations.size,
        tools: 6,
      });
    }

    if (url.pathname !== MCP_PATH) {
      return respondJson(res, 404, { error: `Not found. MCP endpoint is ${MCP_PATH}` });
    }

    // 无状态：请求即生命周期，结束后显式关闭，避免句柄堆积
    const server = createServer(api);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        respondJson(res, 500, { error: String(error) });
      } else {
        res.end();
      }
    }
  });

  http.listen(config.port, config.host, () => {
    console.log(`x-mcp listening on http://${config.host}:${config.port}${MCP_PATH}`);
  });

  // 预热不阻塞端口监听，失败只提示——首次工具调用会自行重试
  void client
    .warmUp()
    .then(({ operations, transactionReady }) => {
      console.log(
        `warm-up: ${operations} operations, signer ${transactionReady ? 'ready' : 'NOT ready (will retry on first call)'}`,
      );
    })
    .catch((error: unknown) => {
      console.error('warm-up failed:', error instanceof Error ? error.message : String(error));
    });
}

main().catch((error: unknown) => {
  console.error('fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
