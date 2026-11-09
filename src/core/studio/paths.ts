import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Reserved case markers protect even damaged or partly-created cases from legacy writes. */
export async function assertLegacyDestination(destination: string): Promise<void> {
  let current = resolve(destination);
  while (true) {
    try {
      current = await realpath(current);
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  while (true) {
    try {
      await lstat(join(current, '.studio'));
      throw new Error('Legacy output cannot target a managed case');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
