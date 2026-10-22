/**
 * 回归测试：用 QuaX 团队录制的真实快照回放，断言我们的 tid 与 X 自家签名模块逐字节一致。
 *
 * 素材说明：home.html / *.js 是 x.com 的产物，不进 git（见 .gitignore），
 * 缺失时本文件会跳过并提示如何补齐。expected.json 是我们比对的黄金值。
 *
 * 来源：Teskann/QuaX test/fixtures/XClientTransactionId (MIT)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ClientTransaction, ClientTransactionIdError, payloadOf, SourceFetchError } from '../src/tid/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/XClientTransactionId/', import.meta.url));

interface Expected {
  nowMs: number;
  cases: { method: string; path: string; transactionId: string }[];
}

function readFixture(name: string): string | null {
  try {
    return readFileSync(`${FIXTURES}${name}`, 'utf8');
  } catch {
    return null;
  }
}

const sourcesIndex = JSON.parse(readFixture('sources.json') ?? '{}') as Record<string, string>;
const expected = JSON.parse(readFixture('expected.json') ?? '{}') as Expected;
const fixturesPresent = readFixture('home.html') !== null && readFixture('sign.o-CdWq_Iut.js') !== null;

/** 按 sources.json 回放录制文件，代替真实网络。 */
async function replay(url: string): Promise<string> {
  const name = sourcesIndex[url];
  if (!name) {
    throw new Error(
      `The generator asked for ${url}, which is not in the recording. Available: ${Object.keys(sourcesIndex).join(', ')}`,
    );
  }
  const content = readFixture(name);
  if (content === null) throw new Error(`Fixture ${name} is missing`);
  return content;
}

describe.skipIf(!fixturesPresent)('tid 与 X 的签名模块逐字节一致', () => {
  it('能沿 首页 → entry → 导入器 → sign 模块 找到签名模块', async () => {
    await expect(ClientTransaction.fetchSources(replay)).resolves.toBeDefined();
  });

  it.each(expected.cases ?? [])('签名 $method $path', async (testCase) => {
    const sources = await ClientTransaction.fetchSources(replay);
    const transaction = ClientTransaction.fromSources(sources);
    const now = new Date(expected.nowMs);

    const actual = transaction.generateTransactionId(testCase.method, testCase.path, now);
    expect(payloadOf(actual)).toEqual(payloadOf(testCase.transactionId));
  });

  it('生成的 tid 长度稳定为 94 字符', async () => {
    const sources = await ClientTransaction.fetchSources(replay);
    const transaction = ClientTransaction.fromSources(sources);
    const tid = transaction.generateTransactionId('GET', '/i/api/graphql/x/SearchTimeline', new Date(expected.nowMs));
    expect(tid).toHaveLength(94);
  });
});

describe('错误分类', () => {
  it('页面结构被改时报 ClientTransactionIdError，而不是 RangeError', async () => {
    const sources = await ClientTransaction.fetchSources(replay);
    expect(() =>
      ClientTransaction.fromSources({
        homePageHtml: sources.homePageHtml.replaceAll('loading-x-anim', 'gone'),
        signFileText: sources.signFileText,
      }),
    ).toThrow(ClientTransactionIdError);
  });

  it('页面完全为空时报 ClientTransactionIdError', () => {
    expect(() => ClientTransaction.fromSources({ homePageHtml: '', signFileText: '' })).toThrow(
      ClientTransactionIdError,
    );
  });

  it('HTTP 错误是 SourceFetchError，不冒充签名错误', async () => {
    const failing = async () => {
      throw new SourceFetchError('GET https://x.com/home returned HTTP 503', 503);
    };
    await expect(ClientTransaction.fetchSources(failing)).rejects.toBeInstanceOf(SourceFetchError);
  });
});
