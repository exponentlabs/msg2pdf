import { mkdir, open, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** An exclusive lock also protects batches running in other app instances. */
export async function lockOutput(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, '.msg2pdf.lock');
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `The output folder is locked by another batch. If the app crashed, verify no conversion is running, then remove ${path}`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }),
    );
  } catch (error) {
    await handle.close();
    await unlink(path);
    throw error;
  }
  return async () => {
    await handle.close();
    await unlink(path);
  };
}
