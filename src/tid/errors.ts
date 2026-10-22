/**
 * tid 模块的错误类型。
 *
 * 区分两类失败，避免把「X 挂了」误报成「签名算法变了」：
 * - ClientTransactionIdError：页面/脚本结构或算法层面的问题，需要跟进 X 的变更。
 * - SourceFetchError：网络或 HTTP 状态错误，重试即可。
 */

export class ClientTransactionIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientTransactionIdError';
  }
}

export class SourceFetchError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'SourceFetchError';
    this.statusCode = statusCode;
  }
}
