import { deflateSync } from 'node:zlib';

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  table[n] = value >>> 0;
}
function chunk(type: string, bytes: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 255] ?? 0);
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  data.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
export function encodeRgbPng(width: number, height: number, rgb: Buffer): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4_000_000 ||
    rgb.length !== width * height * 3
  )
    throw new Error('INVALID_PIXELS');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export function decodePpm(bytes: Buffer): { width: number; height: number; rgb: Buffer } {
  let offset = 0;
  const token = (): string => {
    while (offset < bytes.length && (bytes[offset] ?? 0) <= 32) offset++;
    const start = offset;
    while (offset < bytes.length && (bytes[offset] ?? 0) > 32) offset++;
    return bytes.subarray(start, offset).toString('ascii');
  };
  if (token() !== 'P6') throw new Error('INVALID_RENDER');
  const width = Number(token());
  const height = Number(token());
  if (
    token() !== '255' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4_000_000
  )
    throw new Error('INVALID_RENDER');
  offset++;
  const rgb = bytes.subarray(offset);
  if (rgb.length !== width * height * 3) throw new Error('INVALID_RENDER');
  return { width, height, rgb };
}
