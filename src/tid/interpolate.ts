/** 数组线性插值，长度不一致直接报错（上游同样处理）。 */
export function interpolate(from: number[], to: number[], f: number): number[] {
  if (from.length !== to.length) {
    throw new Error(`Mismatched interpolation arguments: ${from.length} vs ${to.length}`);
  }
  return from.map((value, i) => value * (1 - f) + to[i] * f);
}
