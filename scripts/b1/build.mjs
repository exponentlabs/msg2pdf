import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

if (process.platform !== 'linux' || process.arch !== 'arm64')
  throw new Error('B1 currently targets Fedora ARM64 only');
if (!process.env.B1_NODE_HEADERS)
  throw new Error('Set B1_NODE_HEADERS to verified Node include/node headers');
const target = resolve('artifacts/b1/app');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
execFileSync(
  'cc',
  [
    '-shared',
    '-fPIC',
    '-Wall',
    '-Wextra',
    '-Werror',
    `-I${process.env.B1_NODE_HEADERS}`,
    'scripts/b1/lock.c',
    '-o',
    `${target}/lock.node`,
  ],
  { stdio: 'inherit' },
);
const bundle = await build({
  entryPoints: ['scripts/b1/main.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: `${target}/main.cjs`,
  metafile: true,
});
// Preserve notices for every package actually bundled into the private assembler.
const packages = new Set();
for (const input of Object.keys(bundle.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(input));
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (metadata.name) {
        packages.add(directory);
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
}
for (const directory of packages) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const output = join(
    target,
    'licenses',
    `${metadata.name.replaceAll('/', '_')}@${metadata.version}`,
  );
  await mkdir(output, { recursive: true });
  const notices = (await readdir(directory)).filter((file) =>
    /^(license|licence|notice|copying)/i.test(file),
  );
  if (!notices.length) throw new Error(`No upstream notice for ${metadata.name}`);
  for (const file of notices) await cp(join(directory, file), join(output, file));
}
for (const name of [
  'viewer.html',
  'viewer.mjs',
  'harness.css',
  'preload.cjs',
  'probe.cjs',
  'verify.cjs',
  'evaluation-contract.json',
  'structural.mjs',
])
  await cp(`scripts/b1/${name}`, `${target}/${name}`);
for (const name of ['pdf.mjs', 'pdf.worker.mjs'])
  await cp(`node_modules/pdfjs-dist/build/${name}`, `${target}/${name}`);
await cp('node_modules/pdfjs-dist/web/pdf_viewer.css', `${target}/pdf_viewer.css`);
for (const name of ['standard_fonts', 'cmaps', 'wasm'])
  await cp(`node_modules/pdfjs-dist/${name}`, `${target}/${name}`, { recursive: true });
for (const [source, name] of [
  ['LICENSE', 'LICENSE'],
  ['node_modules/pdfjs-dist/LICENSE', 'PDFJS-LICENSE'],
  ['node_modules/pdf-lib/LICENSE.md', 'PDFLIB-LICENSE'],
])
  await cp(source, `${target}/${name}`);
await writeFile(
  `${target}/package.json`,
  JSON.stringify({
    name: 'msg2pdf-b1',
    version: '0.0.0',
    description: 'Private B1 compatibility experiment; not a redaction product',
    author: 'Exponent Labs',
    license: 'Apache-2.0',
    main: 'main.cjs',
    devDependencies: { electron: '45.2.3' },
  }),
);
execFileSync(
  'pnpm',
  [
    'exec',
    'electron-builder',
    '--projectDir',
    target,
    '--config',
    resolve('scripts/b1/electron-builder.cjs'),
    '--dir',
    '--publish',
    'never',
  ],
  { stdio: 'inherit' },
);
