import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { listPackage } from '@electron/asar';

if (process.platform !== 'linux' || process.arch !== 'arm64')
  throw new Error('Studio qualification requires Fedora ARM64.');
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'msg2pdf-studio-package-'));
const working = join(root, 'approved-case');
const packaged = resolve('release/linux-arm64-unpacked');
const executable = join(packaged, 'resources/bin/msg2pdf');
const files = listPackage(join(packaged, 'resources/app.asar'));
for (const name of [
  'engine.mjs',
  'pdf.mjs',
  'pdf.worker.mjs',
  'assemble.cjs',
  'verify.cjs',
  'raster-policy.cjs',
  'source.cjs',
  'evaluation-contract.json',
])
  assert(files.includes(`/out/studio/${name}`), `Missing packaged studio asset: ${name}`);
assert((await readFile(join(packaged, 'resources/native/studio-lock.node'))).length > 0);
try {
  await run(
    'pnpm',
    ['exec', 'playwright', 'test', 'tests/e2e/studio.spec.ts', '-g', 'captures fixed pages'],
    {
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, MSG2PDF_STUDIO_CASE_EXPORT: working },
    },
  );
  const cli = async (...args) => {
    try {
      const result = await run(executable, ['studio', ...args], {
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      if (typeof error.stdout === 'string' && error.stdout.trim())
        throw new Error(JSON.parse(error.stdout).message, { cause: error });
      throw error;
    }
  };
  const before = await cli('status', working);
  const holder = spawn(
    join(packaged, 'msg2pdf'),
    [
      '-e',
      `
    const [binary, root]=process.argv.slice(1);const lock=require(binary);
    lock.guard(root);lock.acquire(root+'/.studio/locks/case.lock');
    console.log('OWNED');setInterval(()=>{},1000);`,
      join(packaged, 'resources/native/studio-lock.node'),
      working,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Native guard timed out')), 15000);
      holder.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      holder.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Native guard exited'));
      });
      holder.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('OWNED')) {
          clearTimeout(timer);
          resolveReady();
        }
      });
    });
    await rm(join(working, '.studio/locks/case.lock'));
    await assert.rejects(
      cli('status', working),
      (error) => JSON.parse(error.cause.stdout).code === 'CASE_BUSY',
    );
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      const stopped = new Promise((resolveExit) => holder.once('exit', resolveExit));
      holder.kill('SIGKILL');
      await stopped;
    }
  }
  assert.equal((await cli('status', working)).version, before.version);
  assert.equal(before.available, true);
  assert.equal(before.releases.length, 0);
  assert.deepEqual(before.documents[0].blockers, []);
  const published = await cli('publish', working, String(before.version));
  assert.equal(published.releases.length, 1);
  const final = join(working, 'Redacted for sharing', published.releases[0].id);
  assert.deepEqual((await readdir(final)).sort(), ['document-001.pdf', 'manifest.json']);
  const manifest = JSON.parse(await readFile(join(final, 'manifest.json'), 'utf8'));
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(final, 'document-001.pdf')))
      .digest('hex'),
    manifest.files[0].hash,
  );
  await assert.rejects(cli('publish', working, String(published.version)), /RELEASE_UNAPPROVED/);
  const reapplied = await cli('apply', working, before.documents[0].id, String(published.version));
  assert(
    reapplied.documents[0].blockers.some((blocker) => blocker.code === 'CANDIDATE_UNREVIEWED'),
  );
  // A fresh packaged capture/prepare/apply uses the packaged source parser, browser engine,
  // assembler and both system verifiers; no GUI approval is inherited by the new identity.
  const input = join(final, 'document-001.pdf');
  const external = join(root, 'input.pdf');
  const { copyFile } = await import('node:fs/promises');
  await copyFile(input, external);
  const captured = await cli('capture', working, external, String(reapplied.version));
  const id = captured.documents.at(-1).id;
  const prepared = await cli('prepare', working, id, String(captured.version));
  assert(prepared.documents.at(-1).blockers.some((blocker) => blocker.code === 'PAGE_UNREVIEWED'));
  await assert.rejects(cli('apply', working, id, String(prepared.version)), /PAGE_UNREVIEWED/);
  await assert.rejects(cli('approve', working), /Usage:/);
  const earlier = join(root, 'earlier-policy');
  await cli('backup', working, earlier);
  const db = new DatabaseSync(join(earlier, '.studio/case.sqlite'));
  const row = db.prepare('SELECT json FROM state').get();
  const oldState = JSON.parse(row.json);
  oldState.policyHash = '0'.repeat(64);
  db.prepare('UPDATE state SET json=?').run(JSON.stringify(oldState));
  db.close();
  assert.equal((await cli('status', earlier)).policyCurrent, false);
  await assert.rejects(cli('apply', earlier, id, String(prepared.version)), /CASE_POLICY_STALE/);
  await cli('backup', earlier, join(root, 'earlier-policy-backup'));
  console.log(
    'Packaged Fedora ARM64 studio: assets, native lock, GUI approval consumption, atomic release, hashes, scoped preparation and CLI review-bypass rejection passed.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
