/**
 * 端到端冒烟：用官方 MCP 客户端连本机 server，逐个调用工具。
 *
 * 用法：先 `node dist/index.js`，再 `node scripts/mcp-smoke.mjs`。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ENDPOINT = process.env.X_MCP_URL ?? 'http://127.0.0.1:8787/mcp';

const client = new Client({ name: 'x-mcp-smoke', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const tool of tools) console.log(`  ${tool.name} — ${tool.description?.slice(0, 70)}…`);

const call = async (name, args) => {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  let summary = '';
  try {
    const parsed = JSON.parse(text);
    if (parsed.username) summary = `@${parsed.username} followers=${parsed.followers} tweets=${parsed.tweets}`;
    else if (parsed.tweets && Array.isArray(parsed.tweets)) summary = `tweets=${parsed.tweets.length}`;
    else if (parsed.trends) summary = `trends=${parsed.trends.length}`;
    else if (parsed.tweet !== undefined) summary = `replies=${parsed.replies?.length ?? 0}`;
  } catch {
    summary = text.slice(0, 80);
  }
  console.log(`\n${name} (${ms}ms)${result.isError ? ' [ERROR]' : ''}: ${summary}`);
  if (result.isError) console.log(text.slice(0, 300));
  return { result, text };
};

await call('x_user_lookup', { username: 'X' });
await call('x_user_tweets', { username: '@X', limit: 3 });
await call('x_home_timeline', { limit: 3 });
await call('x_search', { query: 'mcp server lang:en', limit: 3 });
await call('x_trends', { woeid: 1 });

const searchOut = await client.callTool({ name: 'x_search', arguments: { query: 'from:X', limit: 1 } });
const tweetId = JSON.parse(searchOut.content.find((c) => c.type === 'text').text).tweets?.[0]?.id;
if (tweetId) await call('x_tweet_detail', { id: tweetId, limit: 3 });
else console.log('\nx_tweet_detail skipped: no tweet id from search');

await client.close();
console.log('\nMCP smoke OK');
