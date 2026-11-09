import { z } from 'zod';

const record = z.record(z.string(), z.unknown());
const reference = /^\d+ \d+ R$/;
/** Inventory all embedded streams, including associated files outside the name tree.
 * Null objects represent external/unreadable file specifications, never exclusions. */
export function pdfInventory(input: unknown): { name: string; object: string | null }[] {
  const graph = record.parse(input);
  const tables = z.array(z.unknown()).length(2).parse(graph.qpdf);
  const objects = record.parse(tables[1]);
  const named = Object.values(record.parse(graph.attachments ?? {})).map((item) =>
    record.parse(item),
  );
  const result: { name: string; object: string | null }[] = [];
  const accounted = new Set<string>();
  const resolve = (value: unknown): Record<string, unknown> => {
    if (typeof value === 'string' && reference.test(value))
      return record.parse(record.parse(objects[`obj:${value}`]).value);
    return record.parse(value);
  };
  for (const [key, raw] of Object.entries(objects)) {
    const object = record.parse(raw);
    if (!object.value || typeof object.value !== 'object') continue;
    const value = record.parse(object.value);
    if (value['/Type'] !== '/Filespec' && !('/EF' in value)) continue;
    const name = named.find((item) => `obj:${String(item.filespec)}` === key)?.preferredname;
    const rawName = name ?? value['/UF'] ?? value['/F'];
    const label =
      typeof rawName === 'string'
        ? rawName.replace(/^u:/, '')
        : `embedded-item-${result.length + 1}.bin`;
    const files = value['/EF'] ? Object.values(resolve(value['/EF'])) : [];
    if (!files.length) result.push({ name: label, object: null });
    for (const ref of new Set(files)) {
      if (
        typeof ref !== 'string' ||
        !reference.test(ref) ||
        !record.parse(objects[`obj:${ref}`]).stream
      )
        result.push({ name: label, object: null });
      else {
        accounted.add(ref);
        result.push({ name: label, object: ref });
      }
    }
  }
  for (const [key, raw] of Object.entries(objects)) {
    const object = record.parse(raw);
    if (!object.stream) continue;
    const dict = record.parse(record.parse(object.stream).dict);
    const ref = key.slice(4);
    if (dict['/Type'] === '/EmbeddedFile' && !accounted.has(ref)) {
      if (!key.startsWith('obj:') || !reference.test(ref)) throw new Error('INVENTORY_INVALID');
      result.push({ name: `embedded-data-${result.length + 1}.bin`, object: ref });
    }
  }
  if (result.length > 64 || result.some((item) => item.name.length > 32768))
    throw new Error('INVENTORY_LIMIT');
  return result;
}
