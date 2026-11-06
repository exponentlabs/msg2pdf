import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { PDFDocument } from 'pdf-lib';

const platform = process.platform;
const folders = await readdir('release', { withFileTypes: true });
const folder = folders.find(
  (entry) =>
    entry.isDirectory() &&
    (platform === 'darwin'
      ? entry.name === (process.arch === 'arm64' ? 'mac-arm64' : 'mac')
      : platform === 'win32'
        ? entry.name === (process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked')
        : entry.name === (process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked')),
);
if (!folder) throw new Error('Build the native portable application with pnpm package:dir first');
const root = resolve('release', folder.name);
const resources =
  platform === 'darwin' ? join(root, 'msg2pdf.app/Contents/Resources') : join(root, 'resources');
const executable =
  platform === 'darwin'
    ? join(root, 'msg2pdf.app/Contents/MacOS/msg2pdf')
    : join(root, platform === 'win32' ? 'msg2pdf.exe' : 'msg2pdf');
const archive = join(resources, 'app.asar');
for (const document of [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'docs/architecture.md',
  'docs/distribution.md',
  'docs/licensing.md',
]) {
  assert(
    (await readFile(join(resources, document))).byteLength > 0,
    `Missing bundled documentation: ${document}`,
  );
}
const files = listPackage(archive);
assert.equal(
  files.filter((file) => /\/out\/renderer\/assets\/poppins-[^/]+\.ttf$/.test(file)).length,
  4,
  'Missing bundled Atlas typography',
);
assert(
  files.some((file) => file.endsWith('/out/main/parser-worker.cjs')),
  'Missing parser worker',
);
assert(
  files.every((file) => !/(?:legacy|python|\.py$|node_modules|tests\/|\.map$)/i.test(file)),
  'Unexpected source/dependency files in app archive',
);
assert(
  (await readFile(join(resources, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).includes(
    '@kenjiuno/msgreader',
  ),
);
assert(
  (await readFile(join(resources, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).includes(
    'Poppins Project Authors',
  ),
  'Missing bundled font licence',
);
const fuses = await getCurrentFuseWire(
  platform === 'darwin' ? join(root, 'msg2pdf.app') : executable,
);
assert.equal(fuses[FuseV1Options.RunAsNode], FuseState.ENABLE);
assert.equal(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], FuseState.DISABLE);
assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
assert.equal(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges], FuseState.DISABLE);
if (platform !== 'linux')
  assert.equal(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], FuseState.ENABLE);
const temporary = await mkdtemp(join(tmpdir(), 'msg2pdf-packaged-'));
try {
  const input = join(temporary, 'mail.eml');
  await writeFile(
    input,
    'From: alex@example.test\r\nTo: taylor@example.test\r\nSubject: Packaged runtime\r\n\r\nNo system Node or Python is needed to convert this message.\r\n',
  );
  const launcher = join(resources, 'bin', platform === 'win32' ? 'msg2pdf.cmd' : 'msg2pdf');
  const args = ['-i', input, '-o', join(temporary, 'pdf'), '--json'];
  // The Windows .cmd path is supplied via an environment variable, avoiding
  // interpolation of installation/user paths into cmd.exe command text.
  let result;
  if (platform === 'win32') {
    const child = spawn(
      process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        '""%MSG2PDF_TEST_LAUNCHER%" -i "%MSG2PDF_TEST_INPUT%" -o "%MSG2PDF_TEST_OUTPUT%" --json"',
      ],
      {
        env: {
          ...process.env,
          MSG2PDF_TEST_LAUNCHER: launcher,
          MSG2PDF_TEST_INPUT: input,
          MSG2PDF_TEST_OUTPUT: join(temporary, 'pdf'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    await new Promise((resolveExit, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolveExit() : reject(new Error(stderr))));
    });
    result = { stdout, stderr };
  } else
    result = await promisify(execFile)(launcher, args, {
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '--this-option-must-be-ignored' },
    });
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.converted, 1);
  assert.equal(summary.failed, 0);
  const pdf = await PDFDocument.load(await readFile(join(temporary, 'pdf/mail.pdf')));
  assert(pdf.getPageCount() > 0);
  console.log(
    `Packaged ${platform}/${process.arch}: archive, notices, fuses, bundled CLI runtime and real PDF conversion passed.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
