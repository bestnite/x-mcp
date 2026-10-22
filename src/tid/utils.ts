/**
 * 数值工具，逐行为对齐 QuaX (Dart) 的实现——它本身是对 Python 版的移植。
 *
 * 三处舍入语义各不相同，混用会让 tid 差一位：
 * - jsRound：JS Math.round，半数向 +∞。
 * - roundTo2：Dart 的 round()，半数远离零。
 * - floatToHex：贪心循环 + 大写 A–F。
 */

/** JS 风格取整：半数向 +∞，与 Math.round 一致（-2.5 → -2）。 */
export function jsRound(num: number): number {
  return Math.round(num);
}

/** 保留两位小数，半数远离零（对齐 Dart 的 round()，不是 Python 的银行家舍入）。 */
export function roundTo2(value: number): number {
  const scaled = value * 100;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / 100;
}

/** 奇数返回 -1，偶数返回 0——插值曲线的起点取值。 */
export function isOdd(num: number): number {
  return num % 2 !== 0 ? -1 : 0;
}

/**
 * 非负浮点数转十六进制字符串，保留小数部分（2.75 → "2.C"）。
 *
 * 不能用 Number.prototype.toString(16)：JS 会自己决定精度和大小写，
 * 而 X 的算法依赖这个贪心循环产生的具体位数。
 */
export function floatToHex(x: number): string {
  const result: string[] = [];
  const fraction = x - Math.trunc(x);
  let quotient = Math.trunc(x);
  let current = x;

  while (quotient > 0) {
    quotient = Math.trunc(current / 16);
    const remainder = Math.trunc(current - quotient * 16);
    result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
    current = quotient;
  }

  if (fraction === 0) return result.join('');

  result.push('.');
  let frac = fraction;
  while (frac > 0) {
    frac *= 16;
    const integer = Math.trunc(frac);
    frac -= integer;
    result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
  }

  return result.join('');
}

/** 把一串字节还原成 tid 载荷：跳过首个随机字节，其余各字节与它 XOR。 */
export function payloadOf(transactionId: string): Buffer {
  const bytes = Buffer.from(transactionId, 'base64');
  const mask = bytes[0];
  return Buffer.from(bytes.subarray(1).map((b) => b ^ mask));
}
