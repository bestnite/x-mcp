/**
 * tid 生成器用到的常量。
 *
 * 移植来源：Teskann/QuaX lib/client/x_client_transaction_id/constants.dart (MIT)
 * 上游谱系：iSarabjitDhiman/XClientTransaction (Python) → QuaX (Dart) → 本项目
 */

/** 参与哈希的固定后缀词，X 前端写死的值。 */
export const DEFAULT_KEYWORD = 'obfiowerehiring';

/** 追加在载荷末尾的固定字节。 */
export const ADDITIONAL_RANDOM_NUMBER = 3;

/** 从 sign 模块里抠 KEY_BYTE 下标的正则，形如 `(e[27], 16)+(e[4], 16)+...`。 */
export const INDICES_REGEX = /\(\w{1}\[(\d{1,2})\],\s*16\)+/g;

/** 首页里指向 entry-client 脚本的 URL。 */
export const ENTRY_SCRIPT_REGEX =
  /["'](https:\/\/abs\.twimg\.com\/[^"']+\/entry-client[\w-]*\.js)["']/;

/** entry 脚本里指向 sign 模块导入器（startup-dynamic / client-transaction-id-plugin）的路径。 */
export const SIGN_IMPORTER_REGEX =
  /["']([./\w-]*(?:client-transaction-id-plugin|startup-dynamic)-[\w-]+\.js)["']/;

/** 导入器里指向 sign 模块本体的路径。 */
export const SIGN_FILE_REGEX = /["'`]([./\w-]*sign\.o-[\w-]+\.js)["'`]/;

/** 抓取 X 页面时伪装成浏览器的请求头。 */
export const BROWSER_HEADERS: Record<string, string> = {
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Referer: 'https://x.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'X-Twitter-Active-User': 'yes',
  'X-Twitter-Client-Language': 'en',
};
