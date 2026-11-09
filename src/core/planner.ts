import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type {
  ConversionPlan,
  ConversionRequest,
  PlanIssue,
  PlannedFile,
} from '../shared/contracts';
import { CancelledError, errorMessage, throwIfCancelled } from '../shared/errors';
import { isWithin } from './filesystem';
import { fileKind } from './formats';
import { LIMITS } from './limits';
import { NameAllocator, pdfNames } from './names';
import { assertLegacyDestination } from './studio/paths';

class DiscoveryLimitError extends Error {}
export async function createPlan(
  request: ConversionRequest,
  signal?: AbortSignal,
): Promise<ConversionPlan> {
  let entriesSeen = 0;
  let metadataBytes = 0;
  function budget(path: string): void {
    throwIfCancelled(signal);
    entriesSeen++;
    metadataBytes += Buffer.byteLength(path) * 4;
    if (entriesSeen > LIMITS.maximumFiles || metadataBytes > 64 * 1024 * 1024)
      throw new DiscoveryLimitError(
        'Discovery exceeds 100,000 entries or 64 MiB of path metadata; select a smaller batch',
      );
  }
  const output = resolve(request.output);
  await assertLegacyDestination(output);
  const canonicalOutput = await realpath(output).catch(() => output);
  const files: PlannedFile[] = [];
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  const topDirectories = new NameAllocator();
  const grouped = new Map<string, PlannedFile[]>();
  const folders = new Map<string, Set<string>>();
  function reserveFolder(parent: string, name: string): string {
    const root = join(output, parent);
    const names = folders.get(root) ?? new Set<string>();
    names.add(name);
    folders.set(root, names);
    return join(parent, name);
  }
  const roots = [...new Set(request.inputs.map((input) => resolve(input)))];
  async function add(source: string, parent: string, explicit: boolean): Promise<void> {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Input must be a regular file, not a symlink');
    const canonical = await realpath(source);
    if (isWithin(canonical, canonicalOutput))
      throw new Error('Choose a separate output folder that does not contain any input');
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const kind = fileKind(basename(source), request.options.allToPdf);
    if (kind === 'unsupported' && !request.options.allToPdf) {
      if (explicit)
        throw new Error(`Unsupported input type: ${extname(source) || '(no extension)'}`);
      return;
    }
    if (files.length >= LIMITS.maximumFiles)
      throw new Error('The batch exceeds the 100,000-file limit');
    const item: PlannedFile = {
      id: randomUUID(),
      source,
      destination: '',
      name: basename(source),
      relativeName: join(parent, basename(source)),
      size: info.size,
      kind,
    };
    files.push(item);
    const target = join(output, parent);
    const group = grouped.get(target) ?? [];
    group.push(item);
    grouped.set(target, group);
  }
  async function walk(source: string, parent: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = [];
      const directory = await opendir(source);
      for await (const entry of directory) {
        budget(join(source, entry.name));
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof DiscoveryLimitError || error instanceof CancelledError) throw error;
      issues.push({ path: source, message: errorMessage(error) });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const directoryNames = new NameAllocator();
    for (const entry of entries) {
      const path = join(source, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({ path, message: 'Symbolic links are excluded from input discovery' });
        continue;
      }
      if (entry.isDirectory()) {
        if (!request.options.recursive) continue;
        if (isWithin(await realpath(path), canonicalOutput)) continue;
        await walk(path, reserveFolder(parent, directoryNames.allocate(entry.name)));
      } else if (entry.isFile()) {
        try {
          await add(path, parent, false);
        } catch (error) {
          if (error instanceof DiscoveryLimitError || error instanceof CancelledError) throw error;
          issues.push({ path, message: errorMessage(error) });
        }
      }
    }
  }
  for (const input of roots) {
    budget(input);
    const info = await lstat(input);
    if (info.isSymbolicLink())
      throw new Error('Select the original input instead of a symbolic link');
    const canonical = await realpath(input);
    if (isWithin(canonical, canonicalOutput))
      throw new Error('Choose a separate output folder that does not contain any input');
    if (info.isDirectory())
      await walk(
        input,
        roots.length > 1 ? reserveFolder('', topDirectories.allocate(basename(input))) : '',
      );
    else await add(input, '', true);
  }
  for (const [parent, group] of grouped) {
    const supported = group.filter((file) => file.kind !== 'unsupported');
    const names = pdfNames(
      supported.map((file) => file.name),
      folders.get(parent),
    );
    for (const [index, item] of supported.entries()) {
      const name = names[index];
      if (!name) throw new Error('Missing destination name');
      item.destination = join(parent, name);
    }
    for (const item of group)
      if (item.kind === 'unsupported') item.destination = join(parent, item.name);
  }
  // A source may have disappeared during discovery; conversions report that
  // individual failure without treating an incomplete export as successful.
  return {
    id: randomUUID(),
    output,
    files,
    issues,
    options: request.options,
    totalBytes: files.reduce((sum, item) => sum + item.size, 0),
  };
}
export function outputAllocators(plan: ConversionPlan): Map<string, NameAllocator> {
  const allocators = new Map<string, NameAllocator>();
  for (const file of plan.files) {
    if (file.kind === 'unsupported') continue;
    const parent = dirname(file.destination);
    const allocator = allocators.get(parent) ?? new NameAllocator();
    allocator.reserve(basename(file.destination));
    allocators.set(parent, allocator);
  }
  return allocators;
}
