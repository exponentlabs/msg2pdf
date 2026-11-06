import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const electron = createRequire(import.meta.url)('electron');
const child = spawn(
  process.execPath,
  [resolve('out/terminal/index.cjs'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, MSG2PDF_ELECTRON_EXE: electron } },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
