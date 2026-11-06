import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { context } from 'esbuild';
import { createServer } from 'vite';
import './build-native.mjs';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};
const contexts = await Promise.all([
  context({
    ...common,
    entryPoints: { index: 'src/main/index.ts', 'parser-worker': 'src/main/parser-worker.ts' },
    outdir: 'out/main',
    outExtension: { '.js': '.cjs' },
  }),
  context({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'out/preload/index.cjs' }),
]);
await Promise.all(contexts.map((item) => item.rebuild()));
await Promise.all(contexts.map((item) => item.watch()));
const server = await createServer();
await server.listen();
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, MSG2PDF_DEV_SERVER_URL: 'http://127.0.0.1:5173' },
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child.kill();
  await server.close();
  await Promise.all(contexts.map((item) => item.dispose()));
  process.exitCode = code;
}
child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(130));
