/**
 * x-client-transaction-id 生成器。
 *
 * 算法来自 X 网页前端的自签名模块（ondemand.s / sign.o），本文件是它的一份
 * 可离线测试的复刻：
 *   1. 从 x.com 首页 meta[twitter-site-verification] 取出 48 字节的 key；
 *   2. 从 sign 模块里抠出 KEY_BYTE 下标，定位首页某个 loading-x-anim 里的动画路径；
 *   3. 用该路径做三次贝塞尔插值，算出一串 hex（animationKey）；
 *   4. tid = base64(randomByte || (keyBytes + timeNow + sha256(...)[0:16] + 3) ^ randomByte)。
 *
 * 移植来源：Teskann/QuaX lib/client/x_client_transaction_id/client_transaction.dart (MIT)
 * 上游谱系：iSarabjitDhiman/XClientTransaction (Python) → QuaX (Dart) → 本项目
 *
 * 逆向过程、各正则的作用、失效排查表与踩坑清单见 docs/reverse-engineering.md。
 * 改这个文件之前先读那份文档，尤其是「为什么比对 tid 要先 XOR 掉首字节」。
 */

import { createHash, randomInt } from 'node:crypto';

import {
  ADDITIONAL_RANDOM_NUMBER,
  BROWSER_HEADERS,
  DEFAULT_KEYWORD,
  ENTRY_SCRIPT_REGEX,
  INDICES_REGEX,
  SIGN_FILE_REGEX,
  SIGN_IMPORTER_REGEX,
} from './constants.js';
import { Cubic } from './cubic.js';
import { ClientTransactionIdError, SourceFetchError } from './errors.js';
import { interpolate } from './interpolate.js';
import { convertRotationToMatrix } from './rotation.js';
import { floatToHex, isOdd, jsRound, roundTo2 } from './utils.js';

/** 时间基准：X 用 2023-05-01 附近的固定纪元做偏移。 */
const TIME_EPOCH_SECONDS = 1682924400;
const TOTAL_TIME = 4096;
const PAGE_URL = 'https://x.com/home';

export type TextFetcher = (url: string) => Promise<string>;

export interface TIDOptions {
  randomKeyword?: string;
  randomNumber?: number;
}

/** x.com 首页 + 签名模块的原始文本，便于测试回放录制文件。 */
export interface TIDSources {
  homePageHtml: string;
  signFileText: string;
}

export class ClientTransaction {
  private constructor(
    private readonly keyBytes: readonly number[],
    private readonly animationKey: string,
    private readonly randomKeyword: string,
    private readonly randomNumber: number,
  ) {}

  /** 联网抓取 x.com 首页与签名模块后构建生成器。 */
  static async initialize(options: TIDOptions = {}): Promise<ClientTransaction> {
    const sources = await ClientTransaction.fetchSources();
    return ClientTransaction.fromSources({ ...sources, ...options });
  }

  /** 依次抓首页 → entry 脚本 → 签名导入器 → 签名模块。 */
  static async fetchSources(fetch: TextFetcher = fetchText): Promise<TIDSources> {
    const homePageHtml = await fetch(PAGE_URL);
    const entryUrl = resolveImport(new URL('https://x.com/'), homePageHtml, ENTRY_SCRIPT_REGEX, 'entry script');
    const entryText = await fetch(entryUrl);
    const importerUrl = resolveImport(
      new URL(entryUrl),
      entryText,
      SIGN_IMPORTER_REGEX,
      'sign module importer',
    );
    const importerText = await fetch(importerUrl);
    const signUrl = resolveImport(new URL(importerUrl), importerText, SIGN_FILE_REGEX, 'sign module');
    const signFileText = await fetch(signUrl);
    return { homePageHtml, signFileText };
  }

  /** 用已抓到的文本构建生成器，不发网络请求。 */
  static fromSources(input: TIDSources & TIDOptions): ClientTransaction {
    const { homePageHtml, signFileText } = input;
    try {
      const { rowIndex, keyBytesIndices } = getIndices(signFileText);
      const keyBytes = getKeyBytes(getKey(homePageHtml));
      const animationKey = computeAnimationKey({ keyBytes, rowIndex, keyBytesIndices, homePageHtml });
      return new ClientTransaction(
        keyBytes,
        animationKey,
        input.randomKeyword ?? DEFAULT_KEYWORD,
        input.randomNumber ?? ADDITIONAL_RANDOM_NUMBER,
      );
    } catch (error) {
      if (error instanceof ClientTransactionIdError) throw error;
      throw new ClientTransactionIdError(
        `Couldn't read the page and the sign module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 为指定请求生成 x-client-transaction-id。
   *
   * 载荷布局（共 70 字节，base64 后 94 字符、无 padding）：
   *
   *   [0]      随机掩码字节（每次调用都不同，因此同一请求两次的 tid 不相等）
   *   [1..48]  首页 meta[twitter-site-verification] 解出的 48 字节 key
   *   [49..52] timeNow 的小端 4 字节
   *   [53..68] sha256("method!path!timeNow" + keyword + animationKey) 的前 16 字节
   *   [69]     固定常量 3（注意：不是随机数）
   *
   * 除 [0] 之外的每个字节都与 [0] XOR。所以比对两个 tid 必须先还原掩码，
   * 见 utils.ts 的 payloadOf()。
   *
   * method/path 是「正在被签名的那次请求」的，因此生成器要按请求调用，
   * 不能每会话只算一次。
   */
  generateTransactionId(method: string, path: string, now: Date = new Date()): string {
    const timeNow = Math.floor((now.getTime() - TIME_EPOCH_SECONDS * 1000) / 1000);
    // 4 字节小端序
    const timeNowBytes = Array.from({ length: 4 }, (_, i) => (timeNow >> (i * 8)) & 0xff);

    const hashInput = `${method}!${path}!${timeNow}${this.randomKeyword}${this.animationKey}`;
    const hashBytes = createHash('sha256').update(hashInput, 'utf8').digest();

    const randomNum = randomInt(0, 256);
    const payload = [...this.keyBytes, ...timeNowBytes, ...hashBytes.subarray(0, 16), this.randomNumber];
    const out = Buffer.alloc(payload.length + 1);
    out[0] = randomNum;
    for (let i = 0; i < payload.length; i++) {
      out[i + 1] = payload[i] ^ randomNum;
    }

    return out.toString('base64').replace(/=/g, '');
  }
}

// --- 内部实现 ---

/** 默认的文本抓取器：失败一律抛 SourceFetchError，不冒充签名错误。 */
async function fetchText(url: string): Promise<string> {
  const response = await globalThis.fetch(url, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    throw new SourceFetchError(`GET ${url} returned HTTP ${response.status}`, response.status);
  }
  return response.text();
}

function resolveImport(base: URL, text: string, regex: RegExp, what: string): string {
  const match = new RegExp(regex.source, regex.flags).exec(text);
  if (!match) throw new ClientTransactionIdError(`Couldn't find the ${what}`);
  return new URL(match[1], base).toString();
}

/** 从 sign 模块里读出 (行下标, KEY_BYTE 下标列表)。 */
function getIndices(signFileText: string): { rowIndex: number; keyBytesIndices: number[] } {
  const indices: number[] = [];
  const regex = new RegExp(INDICES_REGEX.source, INDICES_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(signFileText)) !== null) {
    indices.push(Number(match[1]));
  }
  if (indices.length === 0) throw new ClientTransactionIdError("Couldn't get KEY_BYTE indices");
  return { rowIndex: indices[0], keyBytesIndices: indices.slice(1) };
}

/** 首页里的 48 字节 verification key。 */
function getKey(html: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/name=["']twitter-site-verification["']/i.test(tag)) continue;
    const content = /content=["']([^"']+)["']/i.exec(tag);
    if (content) return content[1];
  }
  throw new ClientTransactionIdError("Couldn't get [twitter-site-verification] key from the page source");
}

function getKeyBytes(key: string): number[] {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length === 0) throw new ClientTransactionIdError("Couldn't decode the verification key");
  return [...bytes];
}

/** 取出某个 loading-x-anim 里的动画路径，切成二维数字数组。 */
function get2dArray(keyBytes: readonly number[], html: string): number[][] {
  const frames = [
    ...html.matchAll(/<svg\b[^>]*\bid=["']loading-x-anim[^"']*["'][^>]*>([\s\S]*?)<\/svg>/gi),
  ].map((m) => m[1]);
  if (frames.length === 0) throw new ClientTransactionIdError("Couldn't find the loading-x-anim frames");

  const frame = frames[keyBytes[5] % 4];
  if (frame === undefined) throw new ClientTransactionIdError('The animation frame index is out of range');

  // 每个 frame 里第 2 个 path 才是动画路径，第 1 个是 X 的 logo
  const paths = [...frame.matchAll(/<path\b[^>]*\bd=["']([^"']*)["']/gi)].map((m) => m[1]);
  const d = paths[1];
  if (d === undefined) throw new ClientTransactionIdError("Couldn't find the animation path");

  // 三段解析，每一步都踩过坑：
  // 1. substring(9) 按位置砍掉路径前缀 "M 10,30 C"——前缀一变长就会连数据一起吃掉；
  // 2. 按 'C' 切成若干段三次贝塞尔；
  // 3. 每段里的**所有**数字都算数据，包括 h / s 命令后面的坐标。把它们当"非曲线值"过滤掉，
  //    后续每一列都会整体前移，算法就再也对不上。
  return d
    .substring(9)
    .split('C')
    .map((segment) =>
      segment
        .replace(/[^\d]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0)
        .map(Number),
    )
    .filter((row) => row.length > 0);
}

function solve(value: number, minVal: number, maxVal: number, rounding: boolean): number {
  const result = (value * (maxVal - minVal)) / 255 + minVal;
  return rounding ? Math.floor(result) : roundTo2(result);
}

function animate(frames: number[], targetTime: number): string {
  const fromColor = [frames[0], frames[1], frames[2], 1];
  const toColor = [frames[3], frames[4], frames[5], 1];
  const fromRotation = [0];
  const toRotation = [solve(frames[6], 60, 360, true)];

  const curves = frames
    .slice(7)
    .map((value, index) => solve(value, isOdd(index), 1, false));

  const cubic = new Cubic(curves);
  const val = cubic.getValue(targetTime);

  const color = interpolate(fromColor, toColor, val).map((v) => Math.min(Math.max(v, 0), 255));
  const rotation = interpolate(fromRotation, toRotation, val);
  const matrix = convertRotationToMatrix(rotation[0]);

  const parts: string[] = [];
  for (let i = 0; i < color.length - 1; i++) {
    // 颜色通道已钳制在 0–255，此处四舍五入与 Dart 的 round() 等价
    parts.push(Math.round(color[i]).toString(16));
  }
  for (const value of matrix) {
    let rounded = roundTo2(value);
    if (rounded < 0) rounded = -rounded;
    const hexValue = floatToHex(rounded);
    if (hexValue.startsWith('.')) {
      parts.push(`0${hexValue}`.toLowerCase());
    } else if (hexValue.length > 0) {
      parts.push(hexValue);
    } else {
      parts.push('0');
    }
  }
  parts.push('0', '0');

  return parts.join('').replace(/[.-]/g, '');
}

function computeAnimationKey(input: {
  keyBytes: readonly number[];
  rowIndex: number;
  keyBytesIndices: readonly number[];
  homePageHtml: string;
}): string {
  const { keyBytes, rowIndex, keyBytesIndices, homePageHtml } = input;
  // 两个下标不是一回事，写反了照样能算出 94 字符的 tid，只是 X 会拒：
  // - keyBytes[rowIndex]（rowIndex 来自 sign 模块里第一个下标）选「动画行」；
  // - keyBytes[5] 选「哪个 loading-x-anim 元素」。
  const frameRowIndex = keyBytes[rowIndex] % 16;
  const frameTimeProduct = keyBytesIndices.reduce((acc, idx) => acc * (keyBytes[idx] % 16), 1);
  const frameTime = jsRound(frameTimeProduct / 10) * 10;

  const rows = get2dArray(keyBytes, homePageHtml);
  const frameRow = rows[frameRowIndex];
  if (frameRow === undefined) {
    throw new ClientTransactionIdError(
      `The animation row ${frameRowIndex} is out of range (only ${rows.length} rows)`,
    );
  }
  return animate(frameRow, frameTime / TOTAL_TIME);
}
