import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.platform === 'linux' && process.arch === 'arm64') {
  await mkdir('resources/native', { recursive: true });
  const result = spawnSync(
    'cc',
    [
      '-shared',
      '-fPIC',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-I${resolve('native/linux/node-api')}`,
      resolve('native/linux/studio-lock.c'),
      '-o',
      resolve('resources/native/studio-lock.node'),
    ],
    { stdio: 'inherit' },
  );
  if (result.error)
    throw new Error(`A C compiler is required for the Fedora studio lock: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform === 'win32') {
  await mkdir('resources/native', { recursive: true });
  const result = spawnSync(
    'cl.exe',
    [
      '/nologo',
      '/std:c++20',
      '/EHsc',
      '/W4',
      '/WX',
      '/MT',
      '/O2',
      '/guard:cf',
      '/DUNICODE',
      '/D_UNICODE',
      '/D_WIN32_WINNT=0x0A00',
      resolve('native/windows/office-sandbox.cpp'),
      `/Fe:${resolve('resources/native/office-sandbox.exe')}`,
      `/Fo:${resolve('resources/native/office-sandbox.obj')}`,
      '/link',
      '/DYNAMICBASE',
      '/NXCOMPAT',
      '/GUARD:CF',
    ],
    { stdio: 'inherit' },
  );
  if (result.error)
    throw new Error(
      `Build the Windows package from an MSVC Developer Command Prompt: ${result.error.message}`,
    );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
