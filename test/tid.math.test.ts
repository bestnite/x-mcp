import { describe, expect, it } from 'vitest';

import { Cubic } from '../src/tid/cubic.js';
import { floatToHex, isOdd, jsRound, payloadOf, roundTo2 } from '../src/tid/utils.js';

describe('jsRound', () => {
  it('half 向 +∞ 取整，与 JS Math.round 一致', () => {
    expect(jsRound(2.5)).toBe(3);
    expect(jsRound(3.5)).toBe(4);
    expect(jsRound(2.49)).toBe(2);
    expect(jsRound(7)).toBe(7);
  });

  it('负半数向零，而不是远离零', () => {
    expect(jsRound(-2.5)).toBe(-2);
    expect(jsRound(-2.51)).toBe(-3);
  });
});

describe('roundTo2', () => {
  it('保留两位小数', () => {
    expect(roundTo2(3.14159)).toBe(3.14);
  });

  it('半数远离零，两个符号都一致', () => {
    expect(roundTo2(1.0050001)).toBe(1.01);
    expect(roundTo2(-1.567)).toBe(-1.57);
  });
});

describe('isOdd', () => {
  it('奇数 -1、偶数 0', () => {
    expect(isOdd(3)).toBe(-1);
    expect(isOdd(4)).toBe(0);
    expect(isOdd(0)).toBe(0);
  });
});

describe('floatToHex', () => {
  it('整数用大写 A–F', () => {
    expect(floatToHex(255)).toBe('FF');
    expect(floatToHex(10)).toBe('A');
    expect(floatToHex(0)).toBe('');
  });

  it('保留小数部分', () => {
    expect(floatToHex(2.75)).toBe('2.C');
  });
});

describe('Cubic', () => {
  it('t=0 与 t=1 的端点', () => {
    const cubic = new Cubic([0.5, 0, 0.5, 1]);
    expect(cubic.getValue(0)).toBe(0);
    expect(cubic.getValue(1)).toBe(1);
  });
});

describe('payloadOf', () => {
  it('去掉随机首字节后还原载荷', () => {
    // 手工构造：载荷 [1,2,3]，随机字节 0xff
    const payload = Buffer.from([1, 2, 3]);
    const mask = 0xff;
    const encoded = Buffer.concat([Buffer.from([mask]), Buffer.from(payload.map((b) => b ^ mask))]);
    expect(payloadOf(encoded.toString('base64'))).toEqual(payload);
  });
});
