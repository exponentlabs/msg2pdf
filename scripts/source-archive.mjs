import { spawnSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// An explicit allowlist prevents caches, old Python code, personal files and
// conversion outputs from accidentally entering a source distribution.
const entries = ['src', 'tests', 'scripts', 'native', 'build', 'docs', '.github', 'resources'];
const files = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.node-version',
  '.gitignore',
  '.gitattributes',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'biome.json',
  'tsconfig.base.json',
  'tsconfig.node.json',
  'tsconfig.renderer.json',
  'vite.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'electron-builder.config.cjs',
];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source archive refuses symlink: ${path}`);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && !/\.(?:exe|obj|pdb)$/i.test(path)) files.push(path);
  }
}
for (const directory of entries) await collect(directory);
files.sort();
await mkdir('release', { recursive: true });
const result = spawnSync('tar', ['-czf', 'release/msg2pdf-source.tar.gz', ...files], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Archived ${files.length} selected source files.`);
