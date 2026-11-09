import { constants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIMITS } from './limits';
import { assertLegacyDestination } from './studio/paths';

export function isWithin(candidate: string, root: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function inspectOutput(
  destination: string,
  root: string,
  createParents = false,
): Promise<boolean> {
  const absoluteRoot = resolve(root);
  const target = resolve(destination);
  if (!isWithin(target, absoluteRoot) || target === absoluteRoot)
    throw new Error('Output escapes the selected destination');
  if (createParents) await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(absoluteRoot).catch((error: unknown) => {
    if (isMissing(error) && !createParents) return absoluteRoot;
    throw error;
  });
  let current = canonicalRoot;
  const parts = relative(absoluteRoot, target).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const final = index === parts.length - 1;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`Output path contains a symlink or junction: ${current}`);
      if (!final && !info.isDirectory())
        throw new Error(`Output parent is not a directory: ${current}`);
      if (final && !info.isFile()) throw new Error(`Output path is not a regular file: ${current}`);
      if (!isWithin(await realpath(current), canonicalRoot))
        throw new Error('Output escapes the selected destination');
      if (final) return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!final && createParents) {
        await mkdir(current, { mode: 0o700 }).catch((caught: unknown) => {
          if (!(caught instanceof Error && 'code' in caught && caught.code === 'EEXIST'))
            throw caught;
        });
        const created = await lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory())
          throw new Error('Output parent is not a safe directory');
      }
    }
  }
  return false;
}
export async function shouldWrite(
  destination: string,
  root: string,
  overwrite: boolean,
): Promise<boolean> {
  return !(await inspectOutput(destination, root)) || overwrite;
}
export async function atomicWrite(
  destination: string,
  root: string,
  data: Uint8Array,
  overwrite: boolean,
): Promise<boolean> {
  if (data.byteLength > LIMITS.pdfBytes) throw new Error('Output exceeds the 256 MiB limit');
  return atomicProduce(destination, root, overwrite, async (temporary) => {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
  });
}
export async function atomicProduce(
  destination: string,
  root: string,
  overwrite: boolean,
  produce: (temporary: string) => Promise<void>,
): Promise<boolean> {
  await assertLegacyDestination(destination);
  if (!(await shouldWrite(destination, root, overwrite))) return false;
  await inspectOutput(destination, root, true);
  const scratch = await mkdtemp(join(dirname(destination), '.msg2pdf-'));
  const temporary = join(scratch, 'output');
  try {
    await produce(temporary);
    const info = await lstat(temporary);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > LIMITS.pdfBytes)
      throw new Error('Invalid or oversized conversion output');
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await inspectOutput(destination, root, true);
    if (overwrite) await rename(temporary, destination);
    else {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
        throw error;
      }
      await unlink(temporary);
    }
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function atomicCopy(
  source: string,
  destination: string,
  root: string,
  overwrite: boolean,
): Promise<boolean> {
  if ((await stat(source)).size > LIMITS.inputBytes)
    throw new Error('Input exceeds the 100 MiB limit');
  return atomicProduce(destination, root, overwrite, (temporary) =>
    copyFile(source, temporary, constants.COPYFILE_EXCL),
  );
}
