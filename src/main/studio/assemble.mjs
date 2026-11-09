import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  table[n] = c >>> 0;
}
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  data.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function png(width, height, rgb) {
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
async function main() {
  const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!Array.isArray(request.pages) || request.pages.length < 1 || request.pages.length > 8)
    throw new Error('PAGE_LIMIT');
  const pdf = await PDFDocument.create({ updateMetadata: false });
  let pixels = 0;
  for (const page of request.pages) {
    const width = Math.ceil(page.width * 2);
    const height = Math.ceil(page.height * 2);
    pixels += width * height;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 4000 ||
      height > 4000 ||
      pixels > 4_000_000
    )
      throw new Error('PIXEL_LIMIT');
    const rgb = Buffer.from(page.referenceRgb, 'base64');
    if (rgb.length !== width * height * 3) throw new Error('INVALID_SNAPSHOT');
    for (const [x, y, w, h] of page.regions) {
      if (
        ![x, y, w, h].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        w <= 0 ||
        h <= 0 ||
        (x + w) * 2 > width ||
        (y + h) * 2 > height
      )
        throw new Error('INVALID_REGION');
      for (let py = y * 2; py < (y + h) * 2; py++)
        for (let px = x * 2; px < (x + w) * 2; px++)
          rgb.fill(0, (py * width + px) * 3, (py * width + px) * 3 + 3);
    }
    const image = await pdf.embedPng(png(width, height, rgb));
    pdf
      .addPage([page.width, page.height])
      .drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
  }
  pdf.setProducer('msg2pdf raster-v1');
  pdf.setCreator('msg2pdf');
  const bytes = await pdf.save({ useObjectStreams: false });
  if (bytes.length > 96 * 1024 * 1024) throw new Error('OUTPUT_LIMIT');
  writeFileSync(process.argv[3], bytes, { mode: 0o600, flag: 'wx' });
  console.log('ASSEMBLED');
}
main().catch(() => {
  console.error('ASSEMBLY_FAILED');
  process.exitCode = 1;
});
