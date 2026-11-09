import type { Matrix, Rectangle } from '../../shared/studio';

export function transformPoint(matrix: Matrix, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}
export function inversePoint(matrix: Matrix, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new Error('Invalid page transform');
  return [(d * (x - e) - c * (y - f)) / determinant, (-b * (x - e) + a * (y - f)) / determinant];
}
export function transformRectangle(matrix: Matrix, rect: Rectangle): Rectangle {
  const points = [
    transformPoint(matrix, rect[0], rect[1]),
    transformPoint(matrix, rect[2], rect[1]),
    transformPoint(matrix, rect[0], rect[3]),
    transformPoint(matrix, rect[2], rect[3]),
  ];
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}
export function pixelRegion(
  matrix: Matrix,
  rect: Rectangle,
  width: number,
  height: number,
): Rectangle {
  const [x1, y1, x2, y2] = transformRectangle(matrix, rect);
  const left = Math.max(0, Math.floor(x1 * 2));
  const top = Math.max(0, Math.floor(y1 * 2));
  const right = Math.min(Math.ceil(width * 2), Math.ceil(x2 * 2));
  const bottom = Math.min(Math.ceil(height * 2), Math.ceil(y2 * 2));
  if (right <= left || bottom <= top) throw new Error('EMPTY_REGION');
  return [left / 2, top / 2, (right - left) / 2, (bottom - top) / 2];
}
