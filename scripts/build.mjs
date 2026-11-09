import { rm } from 'node:fs/promises';
import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import './build-native.mjs';
import './licenses.mjs';
import { buildStudio } from './build-studio.mjs';

await rm('out', { recursive: true, force: true });
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
  legalComments: 'eof',
};
await Promise.all([
  bundle({
    ...common,
    entryPoints: { index: 'src/main/index.ts', 'parser-worker': 'src/main/parser-worker.ts' },
    outdir: 'out/main',
    outExtension: { '.js': '.cjs' },
  }),
  bundle({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'out/preload/index.cjs' }),
  bundle({ ...common, entryPoints: ['src/terminal/index.ts'], outfile: 'out/terminal/index.cjs' }),
]);
await buildRenderer();
await buildStudio();
