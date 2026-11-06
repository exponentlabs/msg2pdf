import { extname } from 'node:path';

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
export const NAME_BUDGET = 220;
export function nameKey(value: string): string {
  return value.normalize('NFC').toUpperCase().toLowerCase();
}
export function safeName(value: string): string {
  let name = Array.from(value.normalize('NFC'), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159) || '<>:"/\\|?*'.includes(character)
      ? '_'
      : character;
  })
    .join('')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = 'unnamed';
  return RESERVED.test(name) ? `_${name}` : name;
}
function truncate(value: string, budget: number): string {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > budget) break;
    output += character;
  }
  return output;
}
export function limitedName(value: string, marker = ''): string {
  const safe = safeName(value);
  const extension = truncate(extname(safe), 32);
  const stem = extname(safe) ? safe.slice(0, -extname(safe).length) : safe;
  return `${truncate(stem, NAME_BUDGET - Buffer.byteLength(extension + marker))}${marker}${extension}`;
}
export class NameAllocator {
  private readonly used: Set<string>;
  private readonly next = new Map<string, number>();
  constructor(reserved: Iterable<string> = []) {
    this.used = new Set(Array.from(reserved, nameKey));
  }
  reserve(value: string): void {
    this.used.add(nameKey(value));
  }
  allocate(base: string): string {
    let candidate = limitedName(base);
    const key = nameKey(candidate);
    let number = this.next.get(key) ?? 2;
    while (this.used.has(nameKey(candidate))) candidate = limitedName(base, ` (${number++})`);
    this.next.set(key, number);
    this.used.add(nameKey(candidate));
    return candidate;
  }
}
export function pdfNames(names: string[], reserved: Iterable<string> = []): string[] {
  const desired = names.map((name) =>
    extname(name).toLowerCase() === '.pdf'
      ? safeName(name)
      : `${safeName(name.slice(0, -extname(name).length))}.pdf`,
  );
  const counts = new Map<string, number>();
  for (const name of desired) counts.set(nameKey(name), (counts.get(nameKey(name)) ?? 0) + 1);
  const allocator = new NameAllocator(reserved);
  const result = new Map<number, string>();
  for (const [index, name] of names.entries()) {
    if (extname(name).toLowerCase() === '.pdf') result.set(index, allocator.allocate(name));
  }
  for (const [index, name] of names.entries()) {
    if (result.has(index)) continue;
    const target = desired[index];
    if (!target) throw new Error('Missing planned output name');
    result.set(
      index,
      allocator.allocate((counts.get(nameKey(target)) ?? 0) > 1 ? `${name}.pdf` : target),
    );
  }
  return names.map((_, index) => {
    const name = result.get(index);
    if (!name) throw new Error('Missing allocated output name');
    return name;
  });
}
export function attachmentLeaf(value: string, index: number): string {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.trim();
  return !leaf || leaf === '(unnamed attachment)' || /^[. ]+$/.test(leaf)
    ? `attachment-${index + 1}`
    : safeName(leaf);
}
