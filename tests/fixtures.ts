import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as CFB from 'cfb';
import iconv from 'iconv-lite';

export const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=',
  'base64',
);

/** Synthetic CFB/MAPI data; no Outlook exports, personal data, or GPL tooling. */
export function msgFixture(
  options: {
    html?: string;
    text?: string;
    attachment?: boolean;
    messageClass?: string;
    subject?: string;
    rtf?: string;
    mime?: Buffer;
  } = {},
): Buffer {
  const cfb = CFB.utils.cfb_new({ root: 'Root Entry' });
  const add = (path: string, bytes: Buffer): void => {
    CFB.utils.cfb_add(cfb, path, bytes);
  };
  const string = (tag: string, value: string, folder = ''): void =>
    add(`${folder}__substg1.0_${tag}001F`, Buffer.from(`${value}\0`, 'utf16le'));
  add('__properties_version1.0', Buffer.alloc(32));
  string('001A', options.messageClass ?? 'IPM.Note');
  string('0037', options.subject ?? 'Café project update');
  string('0C1A', 'Alex Example');
  string('5D01', 'alex@example.test');
  string('1000', options.text ?? (options.rtf ? '' : 'A plain-text message.'));
  if (options.rtf) {
    const rtf = Buffer.from(options.rtf);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(rtf.length + 12, 0);
    header.writeUInt32LE(rtf.length, 4);
    header.writeUInt32LE(0x414c454d, 8);
    add('__substg1.0_10090102', Buffer.concat([header, rtf]));
  }
  if (options.html) add('__substg1.0_10130102', iconv.encode(options.html, 'windows-1252'));
  if (options.attachment || options.mime) {
    const folder = '__attach_version1.0_#00000000/';
    add(`${folder}__properties_version1.0`, Buffer.alloc(8));
    string('3707', options.mime ? 'smime.p7m' : '../../notes.txt', folder);
    string('370E', options.mime ? 'multipart/signed' : 'text/plain', folder);
    add(`${folder}__substg1.0_37010102`, options.mime ?? Buffer.from('Attached notes.\n'));
  }
  const bytes: unknown = CFB.write(cfb, { type: 'buffer' });
  if (!Buffer.isBuffer(bytes)) throw new Error('CFB fixture writer returned an invalid buffer');
  return bytes;
}

export function emlFixture(): string {
  return [
    'From: Alex Example <alex@example.test>',
    'To: Taylor Example <taylor@example.test>',
    'Subject: Project update',
    'Date: Thu, 5 Nov 2026 09:30:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mixed"',
    '',
    '--mixed',
    'Content-Type: multipart/related; boundary="related"',
    '',
    '--related',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '<h2>Ready for review</h2><p>A café, a clear plan, and a quieter inbox.</p><img src="cid:logo"><img src="https://example.invalid/tracker"><script>window.pwned=true</script>',
    '--related',
    'Content-Type: image/png',
    'Content-ID: <logo>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    PIXEL.toString('base64'),
    '--related--',
    '--mixed',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Disposition: attachment; filename="notes.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('Meeting notes.\n').toString('base64'),
    '--mixed--',
    '',
  ].join('\r\n');
}
export async function writeFixtures(directory: string): Promise<{ msg: string; eml: string }> {
  await mkdir(directory, { recursive: true });
  const msg = join(directory, 'update.msg');
  const eml = join(directory, 'message.eml');
  await writeFile(msg, msgFixture({ html: '<p>It’s ready — café update.</p>', attachment: true }));
  await writeFile(eml, emlFixture());
  return { msg, eml };
}

export async function writeOfficeFixture(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const cfb = CFB.utils.cfb_new({ root: 'Root Entry' });
  const add = (path: string, content: string): void => {
    CFB.utils.cfb_add(cfb, path, Buffer.from(content));
  };
  add(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  add(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  add(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office conversion integration fixture</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
  );
  CFB.utils.cfb_del(cfb, '\u0001Sh33tJ5');
  const bytes: unknown = CFB.write(cfb, { type: 'buffer', fileType: 'zip' });
  if (!Buffer.isBuffer(bytes)) throw new Error('Invalid ZIP fixture');
  const path = join(directory, 'document.docx');
  await writeFile(path, bytes);
  return path;
}
