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
