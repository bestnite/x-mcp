/** 旋转角（度）转 2×2 变换矩阵，按行展开成 4 个元素。 */
export function convertRotationToMatrix(rotation: number): number[] {
  const rad = (rotation * Math.PI) / 180;
  return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
}
