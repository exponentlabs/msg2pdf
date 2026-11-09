import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEmailBytes } from '../../core/email';
import { buildEmailHtml } from '../../core/html';
import { pdfInventory } from '../../core/studio/pdf-inventory';

// Scoped by the same bwrap/memory/deadline adapter as verification. No host paths or network.
async function main() {
  const kind = process.argv[2];
  if (kind === '.pdf') {
    const graph = JSON.parse(
      execFileSync(
        '/usr/bin/prlimit',
        [
          '--as=536870912',
          '--cpu=15',
          '--',
          '/usr/bin/qpdf',
          '--json',
          '--json-stream-data=none',
          '/work/input.pdf',
        ],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      ).toString(),
    );
    const entries = pdfInventory(graph);
    let total = 0;
    const attachments = [];
    for (const [index, entry] of entries.entries()) {
      if (!entry.object) {
        attachments.push({ name: entry.name, file: null, inline: false });
        continue;
      }
      const bytes = execFileSync(
        '/usr/bin/prlimit',
        [
          '--as=536870912',
          '--cpu=15',
          '--',
          '/usr/bin/qpdf',
          `--show-object=${entry.object.split(' ').slice(0, 2).join(',')}`,
          '--filtered-stream-data',
          '/work/input.pdf',
        ],
        { timeout: 15000, maxBuffer: 64 * 1024 * 1024 },
      );
      total += bytes.length;
      if (total > 128 * 1024 * 1024) throw new Error('INVENTORY_LIMIT');
      const file = `attachment-${index}.bin`;
      await writeFile(join('/work', file), bytes, { flag: 'wx', mode: 0o600 });
      attachments.push({ name: entry.name, file, inline: false });
    }
    console.log(JSON.stringify({ attachments, html: null }));
    return;
  }
  if (kind !== '.msg' && kind !== '.eml') throw new Error('UNSUPPORTED_SOURCE');
  const message = await parseEmailBytes(await readFile('/work/input.pdf'), kind);
  if (message.attachments.length > 64) throw new Error('INVENTORY_LIMIT');
  const attachments = [];
  for (const [index, attachment] of message.attachments.entries()) {
    const file = attachment.data ? `attachment-${index}.bin` : null;
    if (file)
      await writeFile(join('/work', file), attachment.data ?? new Uint8Array(), {
        flag: 'wx',
        mode: 0o600,
      });
    attachments.push({ name: attachment.name, file, inline: attachment.inline });
  }
  const html = buildEmailHtml(message);
  if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error('BODY_LIMIT');
  console.log(JSON.stringify({ attachments, html }));
}
main().catch(() => {
  console.error('SOURCE_PREPARATION_FAILED');
  process.exitCode = 2;
});
