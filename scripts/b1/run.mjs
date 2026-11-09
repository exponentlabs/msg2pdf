import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { chromium } from '@playwright/test';
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import { fixtures } from './fixtures.mjs';

const execute = promisify(execFile);
const root = resolve('artifacts/b1/results', String(Date.now()));
const packageRoot = resolve('artifacts/b1/package/linux-arm64-unpacked');
const executable = join(packageRoot, 'msg2pdf-b1');
const archive = join(packageRoot, 'resources/app.asar');
await mkdir(root, { recursive: true, mode: 0o700 });
const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  releaseEnabled: false,
  scope: 'Synthetic compatibility experiment only',
  checks: [],
  limitations: [
    'No production redaction service, complete adversarial qualification, or release-enabled profile.',
    'Poppler is a host prerequisite, not bundled; MuPDF is externally installed AGPL evaluation only.',
    'PDF.js DOM text selection/rendering proven; a production review editor is not implemented.',
    'Linux lock adapter only; no Windows/macOS or power-loss durability claim.',
  ],
};
let checkerPrefix;
async function checker(operation, args) {
  const translated = args.map((value) =>
    value.startsWith(root) ? `/work${value.slice(root.length)}` : value,
  );
  const result = await execute('/usr/bin/bwrap', [...checkerPrefix, operation, ...translated], {
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
const check = (name, detail) => report.checks.push({ name, status: 'passed', detail });
const children = new Set();
const descendants = new Set();
function probe(mode, directory) {
  const child = spawn(executable, [join(archive, 'probe.cjs'), mode, directory], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const exited = once(child, 'exit');
  const first = new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packaged probe timed out'));
    }, 15_000);
    let output = '';
    let diagnostic = '';
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) {
        clearTimeout(timer);
        try {
          resolveLine(JSON.parse(output.split('\n')[0]));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (!output.includes('\n')) reject(new Error(diagnostic || 'Probe exited without evidence'));
    });
  });
  return { child, first, exited };
}
async function stop(probe) {
  probe.child.kill('SIGKILL');
  await probe.exited;
}
function ppm(buffer) {
  let offset = 0;
  function token() {
    while (buffer[offset] <= 32) offset++;
    const start = offset;
    while (buffer[offset] > 32) offset++;
    return buffer.subarray(start, offset).toString();
  }
  assert.equal(token(), 'P6');
  const width = Number(token());
  const height = Number(token());
  assert.equal(token(), '255');
  offset++;
  assert.equal(buffer.length - offset, width * height * 3);
  return { width, height, pixels: buffer.subarray(offset) };
}
async function inspect(path, expected, { raster = false } = {}) {
  const info = await checker('pdfinfo', [path]);
  assert.match(info.stdout, new RegExp(`Pages:\\s+${expected.pages.length}\\b`));
  const text = (await checker('pdftotext', [path, '-'])).stdout;
  if (raster) {
    assert.equal(text.trim(), '');
    const attachments = await checker('pdfdetach', ['-list', path]);
    assert.match(attachments.stdout, /^0 embedded files/);
    assert(!info.stdout.includes('METADATA_CANARY'));
    // Supplement Poppler with decoded object inspection; this is not independent of the raster assembler.
    const doc = await PDFDocument.load(await readFile(path));
    for (const [key] of doc.catalog.entries())
      assert(['Type', 'Pages'].includes(key.toString().slice(1)));
    for (const page of doc.getPages()) {
      const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      assert(!annotations || annotations.size() === 0);
      const resources = page.node.Resources();
      const fonts = resources?.lookup(PDFName.of('Font'));
      assert(!fonts || fonts.keys().length === 0);
    }
  }
  for (let index = 0; index < expected.pages.length; index++) {
    const page = expected.pages[index];
    const output = `${path}-page-${index + 1}`;
    await checker('pdftoppm', [
      '-f',
      String(index + 1),
      '-l',
      String(index + 1),
      '-singlefile',
      '-cropbox',
      '-scale-to-x',
      String(Math.round(page.width)),
      '-scale-to-y',
      String(Math.round(page.height)),
      path,
      output,
    ]);
    const image = ppm(await readFile(`${output}.ppm`));
    for (const [x, y, width, height] of page.regions) {
      for (let py = Math.ceil(y) + 2; py < Math.floor(y + height) - 2; py++) {
        for (let px = Math.ceil(x) + 2; px < Math.floor(x + width) - 2; px++) {
          const at = (py * image.width + px) * 3;
          assert(
            image.pixels[at] < 8 && image.pixels[at + 1] < 8 && image.pixels[at + 2] < 8,
            'Mask coverage failed',
          );
        }
      }
    }
    if (index === 1)
      assert(
        image.pixels.some(
          (value, at) =>
            at % 3 === 0 && value > 200 && image.pixels[at + 1] < 30 && image.pixels[at + 2] < 30,
        ),
        'Unmarked reused image lost',
      );
    if (index === 0)
      assert(
        image.pixels.some(
          (value, at) =>
            at % 3 === 1 && value > 150 && image.pixels[at - 1] < 30 && image.pixels[at + 1] < 30,
        ),
        'Unmarked green neighbor lost',
      );
  }
  return {
    text,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  };
}
let application;
let browser;
let applicationExit;
try {
  report.host = {
    os: await readFile('/etc/os-release', 'utf8'),
    kernel: (await execute('uname', ['-r'])).stdout.trim(),
    selinux: (await execute('getenforce')).stdout.trim(),
    poppler: (await execute('/usr/bin/pdftoppm', ['-v'])).stderr.trim(),
  };
  const databaseRoot = join(root, 'case');
  await mkdir(databaseRoot, { recursive: true });
  // Keep the directory unique per invocation so interrupted evidence remains inspectable.
  const owner = probe('hold', databaseRoot);
  const owned = await owner.first;
  assert(owned.held);
  descendants.add(owned.child);
  const inode = (await stat(join(databaseRoot, 'case.lock'))).ino;
  assert.deepEqual(
    {
      journal: owned.settings.journal,
      synchronous: owned.settings.synchronous,
      integrity: owned.settings.integrity,
    },
    { journal: 'delete', synchronous: 2, integrity: 'ok' },
  );
  const contender = probe('inspect', databaseRoot);
  assert.equal((await contender.first).code, 'CASE_BUSY');
  await contender.exited;
  await stop(owner);
  const racers = [probe('race', databaseRoot), probe('race', databaseRoot)];
  const outcomes = await Promise.all(racers.map((item) => item.first));
  assert.equal(outcomes.filter((item) => item.held).length, 1);
  const winner = outcomes.findIndex((item) => item.held);
  assert.deepEqual(outcomes[winner].rows, [{ id: 1, label: 'committed' }]);
  assert.equal(outcomes[winner].settings.integrity, 'ok');
  assert.equal((await stat(join(databaseRoot, 'case.lock'))).ino, inode);
  // Child remains alive across owner death: its inherited descriptors must not retain the lock.
  process.kill(owned.child, 0);
  process.kill(owned.child, 'SIGKILL');
  descendants.delete(owned.child);
  for (let index = 0; index < racers.length; index++) {
    if (index === winner) await stop(racers[index]);
    else await racers[index].exited;
  }
  const aliasRoot = join(root, 'aliased-lock');
  await mkdir(aliasRoot);
  await symlink(join(databaseRoot, 'case.lock'), join(aliasRoot, 'case.lock'));
  const alias = probe('inspect', aliasRoot);
  assert.equal((await alias.first).code, 'CASE_LOCK_UNAVAILABLE');
  await alias.exited;
  check('packaged-sqlite-and-os-lock', {
    settings: owned.settings,
    contention: 'CASE_BUSY',
    recoveryOwners: 1,
    committedRows: 1,
    uncommittedRows: 0,
    childDidNotRetainLock: true,
    stableLockInode: true,
    symlinkRejected: true,
  });

  application = spawn(
    executable,
    ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
    {
      env: { ...process.env, B1_PROFILE: join(root, 'profile') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  applicationExit = once(application, 'exit');
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let diagnostic = '';
    const timer = setTimeout(
      () => reject(new Error(`No development CDP endpoint: ${diagnostic}`)),
      15_000,
    );
    application.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    application.stderr.on('data', (chunk) => {
      diagnostic += chunk;
      const match = diagnostic.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolveEndpoint(match[1]);
      }
    });
    application.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(diagnostic));
    });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForFunction(() => typeof globalThis.b1Viewer === 'function');
  const runtime = await page.evaluate(() => globalThis.b1Harness.runtime());
  assert(runtime.packaged);
  report.runtime = runtime;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => typeof globalThis.b1Viewer === 'function');
  assert.equal(await page.evaluate(() => typeof globalThis.require), 'undefined');
  const attemptedNetwork = [];
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) attemptedNetwork.push(request.url());
  });

  const imageBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 20, 20);
    context.fillStyle = '#0000ff';
    context.fillRect(10, 0, 10, 10);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const samples = await fixtures(imageBase64);
  const modulePath = process.env.B1_MUPDF_MODULE;
  if (!modulePath)
    throw new Error(
      'Set B1_MUPDF_MODULE to separately installed mupdf/dist/mupdf.js for structural evaluation',
    );
  const moduleRoot = dirname(dirname(resolve(modulePath)));
  const moduleMetadata = JSON.parse(await readFile(join(moduleRoot, 'package.json'), 'utf8'));
  assert.equal(moduleMetadata.version, '1.28.6');
  report.structuralEvaluation = {
    name: moduleMetadata.name,
    version: moduleMetadata.version,
    license: moduleMetadata.license,
    bundled: false,
  };
  report.packageHashes = {
    asar: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    lock: createHash('sha256')
      .update(await readFile(`${archive}.unpacked/lock.node`))
      .digest('hex'),
  };
  const entries = listPackage(archive);
  assert(!entries.some((entry) => /node_modules|mupdf|\.map$/.test(entry)));
  for (const asset of ['/pdf.mjs', '/pdf.worker.mjs', '/preload.cjs', '/lock.node'])
    assert(entries.includes(asset));
  const fuses = await getCurrentFuseWire(executable);
  assert.equal(fuses[FuseV1Options.RunAsNode], FuseState.ENABLE);
  for (const option of [
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
    FuseV1Options.GrantFileProtocolExtraPrivileges,
  ])
    assert.equal(fuses[option], FuseState.DISABLE);
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
  check('packaged-assets-and-fuses', {
    dependenciesExcluded: true,
    noBundledMuPdf: true,
    requiredAssetsPresent: true,
    nodeInspectorDisabled: true,
  });
  const isolated = [
    '--unshare-all',
    '--die-with-parent',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind',
    packageRoot,
    '/package',
    '--ro-bind',
    moduleRoot,
    '/mupdf',
    '--bind',
    root,
    '/work',
    '--chdir',
    '/work',
    '--setenv',
    'ELECTRON_RUN_AS_NODE',
    '1',
    '--setenv',
    'B1_MUPDF_MODULE',
    '/mupdf/dist/mupdf.js',
  ];
  checkerPrefix = [...isolated, '/package/msg2pdf-b1', '/package/resources/app.asar/verify.cjs'];
  const contractBytes = await readFile('scripts/b1/evaluation-contract.json');
  const contract = JSON.parse(contractBytes);
  assert.equal(contract.releaseEnabled, false);
  report.contract = {
    ...contract,
    sha256: createHash('sha256').update(contractBytes).digest('hex'),
  };
  report.sourceHashes = {};
  for (const file of (await readdir('scripts/b1')).sort())
    report.sourceHashes[file] = createHash('sha256')
      .update(await readFile(join('scripts/b1', file)))
      .digest('hex');
  const server = createServer((socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    await execute(
      '/usr/bin/bwrap',
      [
        ...isolated,
        '/package/msg2pdf-b1',
        '-e',
        `const fs=require('node:fs'); if(fs.existsSync(${JSON.stringify(resolve('package.json'))})) process.exit(3); const s=require('node:net').connect(${address.port},'127.0.0.1'); s.on('connect',()=>process.exit(4)); s.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(5),2000)`,
      ],
      { timeout: 10_000 },
    );
  } finally {
    server.close();
  }
  check('structural-worker-isolation', {
    unrelatedCheckoutUnreadable: true,
    hostLoopbackUnreachable: true,
  });

  for (const sample of samples) {
    const input = join(root, `${sample.name}.pdf`);
    await writeFile(input, sample.bytes, { mode: 0o600 });
    const rendered = await page.evaluate((input) => globalThis.b1Viewer(input), {
      bytes: sample.bytes.toString('base64'),
      marks: sample.marks,
    });
    assert(rendered.pages.every((item) => item.geometry));
    assert(rendered.pages[0].text.includes('B1_SECRET_CANARY'));
    assert(rendered.pages[0].selection.text.includes('PUBLIC NEIGHBOR'));
    assert(rendered.pages[0].selection.width > 0 && rendered.pages[0].selection.height > 0);
    const output = join(root, `${sample.name}-raster.pdf`);
    const raster = await page.evaluate(
      (pages) => globalThis.b1Harness.assemble(pages),
      rendered.pages,
    );
    await writeFile(output, Buffer.from(raster, 'base64'), { mode: 0o600 });
    const rasterEvidence = await inspect(output, rendered, { raster: true });
    check(`raster:${sample.name}`, {
      sha256: rasterEvidence.sha256,
      pages: rendered.pages.length,
      pdfjs: rendered.version,
      geometryRoundTrip: true,
      selectableText: true,
    });
    await writeFile(join(root, `${sample.name}.json`), JSON.stringify(sample.marks));
    const structural = join(root, `${sample.name}-structural.pdf`);
    await execute(
      '/usr/bin/bwrap',
      [
        ...isolated,
        '/package/msg2pdf-b1',
        '/package/resources/app.asar/structural.mjs',
        `/work/${sample.name}.pdf`,
        `/work/${sample.name}-structural.pdf`,
        `/work/${sample.name}.json`,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const structuralEvidence = await inspect(structural, rendered);
    if (sample.marks.length) assert(!structuralEvidence.text.includes('B1_SECRET_CANARY'));
    else assert(structuralEvidence.text.includes('B1_SECRET_CANARY'));
    assert(structuralEvidence.text.includes('PUBLIC NEIGHBOR'));
    const remaining =
      sample.name === 'hidden-attachment'
        ? {
            hiddenTextRetained: structuralEvidence.text.includes('HIDDEN_OCR_CANARY'),
            attachments: (await checker('pdfdetach', ['-list', structural])).stdout.trim(),
            sourceMetadataRetained: (await checker('pdfinfo', [structural])).stdout.includes(
              'METADATA_CANARY',
            ),
          }
        : undefined;
    check(`structural-removal:${sample.name}`, {
      sha256: structuralEvidence.sha256,
      sanitizationQualified: false,
      remaining,
    });
  }
  // Exercise the same independent-checker entry point with an invalid PDF and a missing binary.
  await writeFile(join(root, 'malformed.pdf'), 'not a PDF');
  await assert.rejects(() => inspect(join(root, 'malformed.pdf'), { pages: [] }, { raster: true }));
  await assert.rejects(() => checker('absent-checker', []));
  await assert.rejects(
    () => checker('deadline-fixture', []),
    (error) => error.stderr.includes('CHECKER_TIMEOUT'),
  );
  assert.deepEqual(attemptedNetwork, []);
  assert.deepEqual(pageErrors, []);
  check('negative-checker-and-offline', {
    malformedRejected: true,
    timedOutCheckerRejected: true,
    missingCheckerRejected: true,
    documentHttpRequests: 0,
  });
  await page.screenshot({ path: join(root, 'viewer.png') });
  report.status = 'compatibility-passed-not-release-qualified';
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  application?.kill('SIGKILL');
  if (applicationExit) await applicationExit;
  for (const child of children) child.kill('SIGKILL');
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        report.status = 'failed';
        report.failure = `Descendant cleanup failed: ${error.code}`;
        process.exitCode = 1;
      }
    }
  }
  await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      report: join(root, 'report.json'),
      failure: report.failure,
    }),
  );
}
