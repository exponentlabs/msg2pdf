import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

const { verifyRaster } = createRequire(import.meta.url)('./raster-policy.cjs');

export async function qualify({ checker, page, root, golden, check, inspect }) {
  const bytes = await readFile(golden.path);
  const decoded = JSON.parse(
    (
      await checker('qpdf', [
        '--json',
        '--json-stream-data=inline',
        '--decode-level=all',
        golden.path,
      ])
    ).stdout,
  );
  const encoded = JSON.parse(
    (
      await checker('qpdf', [
        '--json',
        '--json-stream-data=inline',
        '--decode-level=none',
        golden.path,
      ])
    ).stdout,
  );
  assert(verifyRaster(bytes, decoded, encoded, golden.expected).independentlyAllowlisted);
  const catalogRef = decoded.qpdf[1].trailer.value['/Root'];
  const mutations = [
    [
      'script',
      (objects) => {
        objects[`obj:${catalogRef}`].value['/OpenAction'] = {
          '/S': '/JavaScript',
          '/JS': 'u:SECRET',
        };
      },
    ],
    [
      'tags',
      (objects) => {
        objects[`obj:${catalogRef}`].value['/StructTreeRoot'] = { '/Alt': 'u:SECRET' };
      },
    ],
    [
      'attachments',
      (objects) => {
        objects[`obj:${catalogRef}`].value['/Names'] = { '/EmbeddedFiles': [] };
      },
    ],
    [
      'metadata',
      (objects) => {
        objects[`obj:${catalogRef}`].value['/Metadata'] = '999 0 R';
      },
    ],
    [
      'unreferenced-asset',
      (objects) => {
        objects['obj:999 0 R'] = { value: { '/Secret': 'u:SECRET' } };
      },
    ],
    [
      'previous-revision',
      (objects) => {
        objects.trailer.value['/Prev'] = 100;
      },
    ],
    [
      'image-mask',
      (objects) => {
        Object.values(objects).find(
          (item) => item.stream?.dict['/Subtype'] === '/Image',
        ).stream.dict['/SMask'] = '999 0 R';
      },
    ],
    [
      'hidden-content',
      (objects) => {
        const stream = Object.values(objects).find(
          (item) => item.stream && !item.stream.dict['/Subtype'],
        ).stream;
        stream.data = Buffer.from('BT (SECRET) Tj ET').toString('base64');
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(decoded);
    mutate(changed.qpdf[1]);
    assert.throws(() => verifyRaster(bytes, changed, encoded, golden.expected));
    check(`policy-reject:${name}`, { rejected: true });
  }
  const trailing = join(root, 'trailing-payload.pdf');
  await writeFile(trailing, Buffer.concat([bytes, Buffer.from('\nPRIVATE_TRAILING_PAYLOAD')]));
  await assert.rejects(() => checker('raster', [trailing, `${golden.path}.policy.json`]));
  check('policy-reject:trailing-payload', { rejectedByPackagedWorker: true });

  const unmarked = await page.evaluate((input) => globalThis.b1Viewer(input), {
    bytes: (await readFile(golden.expected.sourcePath)).toString('base64'),
    marks: [],
  });
  const leaked = await page.evaluate(
    (pages) => globalThis.b1Harness.assemble(pages),
    unmarked.pages,
  );
  const leakedPath = join(root, 'mask-not-applied.pdf');
  await writeFile(leakedPath, Buffer.from(leaked, 'base64'));
  await assert.rejects(() => checker('raster', [leakedPath, `${golden.path}.policy.json`]));
  check('policy-reject:missing-mask', { rejectedByPackagedWorker: true });

  const corrupted = structuredClone(golden.expected.pages);
  corrupted[0].png = await page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(80, 520, 320, 80);
    return canvas.toDataURL('image/png').split(',')[1];
  }, corrupted[0].png);
  const altered = await page.evaluate((pages) => globalThis.b1Harness.assemble(pages), corrupted);
  const alteredPath = join(root, 'neighbor-altered.pdf');
  await writeFile(alteredPath, Buffer.from(altered, 'base64'));
  await assert.rejects(() => checker('raster', [alteredPath, `${golden.path}.policy.json`]));
  check('policy-reject:unmarked-pixel-change', { rejectedByPackagedWorker: true });

  const encrypted = join(root, 'encrypted.pdf');
  await checker('qpdf', [
    '--encrypt',
    'user',
    'owner',
    '256',
    '--',
    golden.expected.sourcePath,
    encrypted,
  ]);
  await assert.rejects(() => checker('qpdf', ['--check', encrypted]));
  await assert.rejects(async () =>
    page.evaluate(
      (bytes) => globalThis.b1Viewer({ bytes, marks: [] }),
      (await readFile(encrypted)).toString('base64'),
    ),
  );
  check('source-reject:password-protected', { rejected: true });

  const damaged = join(root, 'damaged.pdf');
  const source = await readFile(golden.expected.sourcePath);
  await writeFile(damaged, source.subarray(0, source.length - 40));
  await assert.rejects(() => checker('qpdf', ['--check', damaged]));
  check('source-reject:repair-required', { qpdfWarningsAreFailure: true });

  const tooMany = await PDFDocument.create();
  for (let index = 0; index < 9; index++) tooMany.addPage([400, 400]);
  await assert.rejects(async () =>
    page.evaluate(
      (bytes) => globalThis.b1Viewer({ bytes, marks: [] }),
      Buffer.from(await tooMany.save()).toString('base64'),
    ),
  );
  check('source-reject:page-limit', { rejectedBeforeRendering: true });
  const tooLarge = await PDFDocument.create();
  tooLarge.addPage([2000, 2000]);
  await assert.rejects(async () =>
    page.evaluate(
      (bytes) => globalThis.b1Viewer({ bytes, marks: [] }),
      Buffer.from(await tooLarge.save()).toString('base64'),
    ),
  );
  check('source-reject:pixel-limit', { rejectedBeforeAllocation: true });
  await assert.rejects(() => inspect(trailing, golden.expected, { raster: true }));
}
