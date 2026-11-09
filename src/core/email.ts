import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { decompressRTF } from '@kenjiuno/decompressrtf';
import MsgReaderImport from '@kenjiuno/msgreader';
import iconv from 'iconv-lite';
import { simpleParser } from 'mailparser';
import { sanitizeBody } from './html';
import { LIMITS } from './limits';
import { decodeRtfBody } from './rtf';

// The package uses a transpiled CommonJS default. Native ESM and the CJS
// production bundle expose different wrappers around the same constructor.
const MsgReader: typeof MsgReaderImport =
  typeof MsgReaderImport === 'function'
    ? MsgReaderImport
    : (MsgReaderImport as unknown as { default: typeof MsgReaderImport }).default;

export interface EmailAttachment {
  name: string;
  contentType: string;
  contentId: string;
  hidden: boolean;
  inline: boolean;
  data: Uint8Array | null;
}
export interface NormalizedEmail {
  subject: string;
  sender: string;
  recipients: string;
  cc: string;
  sentAt: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}
export function normalizeCid(value: string): string {
  let decoded = value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* Malformed percent escapes remain literal IDs. */
  }
  return decoded.trim().replace(/^<|>$/g, '').toLowerCase();
}
export function decodeHtml(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const probe = buffer.subarray(0, 8192).toString('latin1');
  const declared = /charset\s*=\s*["']?\s*([\w.-]+)/i.exec(probe)?.[1];
  if (declared && iconv.encodingExists(declared))
    return iconv.decode(buffer, declared).replaceAll('\0', '');
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer, 'utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return iconv.decode(buffer, 'utf16be');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replaceAll('\0', '');
  } catch {
    return iconv.decode(buffer, 'windows-1252').replaceAll('\0', '');
  }
}
function textField(object: object, ...keys: string[]): string {
  for (const key of keys) {
    const value: unknown = Reflect.get(object, key);
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}
function validateEmail(message: NormalizedEmail): NormalizedEmail {
  for (const field of [
    message.subject,
    message.sender,
    message.recipients,
    message.cc,
    message.sentAt,
  ]) {
    if (Buffer.byteLength(field) > 64 * 1024)
      throw new Error('Email metadata exceeds the 64 KiB per-field limit');
  }
  if (message.attachments.length > 10_000)
    throw new Error('Email exceeds the 10,000-attachment limit');
  if (Buffer.byteLength(message.html) + Buffer.byteLength(message.text) > LIMITS.bodyBytes)
    throw new Error('Email body exceeds the 10 MiB limit');
  let total = 0;
  for (const attachment of message.attachments) {
    if (
      Buffer.byteLength(attachment.name) > 32_768 ||
      Buffer.byteLength(attachment.contentId) > 32_768 ||
      Buffer.byteLength(attachment.contentType) > 4096
    )
      throw new Error('Attachment metadata exceeds the 32 KiB limit');
    const size = attachment.data?.byteLength ?? 0;
    if (size > LIMITS.attachmentBytes)
      throw new Error(`Attachment exceeds the 64 MiB limit: ${attachment.name}`);
    total += size;
  }
  if (total > LIMITS.totalAttachmentBytes)
    throw new Error('Decoded attachments exceed the 128 MiB limit');
  message.html = sanitizeBody(message.html, message.attachments);
  if (Buffer.byteLength(message.html) > 32 * 1024 * 1024)
    throw new Error('Rendered email exceeds the 32 MiB limit');
  return message;
}
async function parseMsg(raw: Buffer): Promise<NormalizedEmail> {
  const reader = new MsgReader(new DataView(raw.buffer, raw.byteOffset, raw.byteLength));
  const fields = reader.getFileData();
  if (fields.error || fields.dataType !== 'msg')
    throw new Error(fields.error || 'Invalid MSG message');
  let html = fields.html ? decodeHtml(fields.html) : (fields.bodyHtml ?? '');
  let text = fields.body ?? '';
  if (!html && !text && fields.compressedRtf) {
    const compressed = Buffer.from(fields.compressedRtf);
    if (compressed.byteLength < 16 || compressed.readUInt32LE(4) > LIMITS.bodyBytes)
      throw new Error('Invalid or oversized compressed RTF body');
    const expanded = Buffer.from(decompressRTF(Array.from(compressed)));
    if (expanded.byteLength > LIMITS.bodyBytes)
      throw new Error('RTF body exceeds the 10 MiB limit');
    const result = await decodeRtfBody(expanded);
    html = result.html;
    text = result.text;
  }
  const recipients = (kind: string): string =>
    (fields.recipients ?? [])
      .filter((recipient) => recipient.recipType === kind)
      .map((recipient) => {
        const address = textField(recipient, 'smtpAddress', 'email');
        return recipient.name && address
          ? `${recipient.name} <${address}>`
          : address || recipient.name || '';
      })
      .filter(Boolean)
      .join(', ');
  const attachments: EmailAttachment[] = (fields.attachments ?? []).map((attachment, index) => {
    let data: Uint8Array | null = null;
    // A referenced file has no embedded data stream. Never resolve a path or
    // URL supplied by a message, including UNC paths that could leak credentials.
    if (attachment.dataId !== undefined || attachment.innerMsgContent)
      data = reader.getAttachment(attachment).content;
    return {
      name:
        attachment.fileName ||
        attachment.fileNameShort ||
        (attachment.innerMsgContent
          ? `${attachment.name || 'attached-email'}.msg`
          : `attachment-${index + 1}`),
      contentType: textField(attachment, 'attachMimeTag', 'mimeTag') || 'application/octet-stream',
      contentId: normalizeCid(attachment.pidContentId ?? ''),
      hidden: attachment.attachmentHidden === true,
      inline: false,
      data,
    };
  });
  const senderEmail = textField(fields, 'senderSmtpAddress', 'senderEmail');
  const message: NormalizedEmail = {
    subject: fields.subject ?? '',
    sender:
      fields.senderName && senderEmail
        ? `${fields.senderName} <${senderEmail}>`
        : senderEmail || fields.senderName || '',
    recipients: recipients('to'),
    cc: recipients('cc'),
    sentAt: fields.clientSubmitTime || fields.messageDeliveryTime || '',
    html,
    text,
    attachments,
  };
  if (/smime/i.test(fields.messageClass ?? '')) {
    if (!/multipartSigned/i.test(fields.messageClass ?? ''))
      throw new Error(
        'Encrypted or opaque S/MIME messages must be decrypted/exported in your mail client first',
      );
    const mime = attachments.find(
      (attachment) => attachment.name.toLowerCase() === 'smime.p7m' && attachment.data,
    );
    if (!mime?.data) throw new Error('Signed MSG has no embedded MIME message');
    const signed = await parseEml(Buffer.from(mime.data));
    message.html = signed.html;
    message.text = signed.text;
    // Retain the signed wrapper and other outer items for studio accountability.
    // The wrapper is private signature material, not an ordinary export attachment.
    mime.hidden = true;
    message.attachments = [...attachments, ...signed.attachments];
  }
  return validateEmail(message);
}
async function parseEml(raw: Buffer): Promise<NormalizedEmail> {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1');
  if (!/^[!-9;-~]+:/m.test(head)) throw new Error('Invalid EML message: no email headers');
  const headers = head.split(/\r?\n\r?\n/, 1)[0]?.replace(/\r?\n[ \t]+/g, ' ') ?? '';
  const contentType = /^content-type:\s*(.+)$/im.exec(headers)?.[1] ?? '';
  if (/application\/(?:x-)?pkcs7-mime|^multipart\/encrypted/i.test(contentType))
    throw new Error(
      'Encrypted or opaque S/MIME messages must be decrypted/exported in your mail client first',
    );
  if (/^multipart\//i.test(contentType)) {
    const boundary = /boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
    const delimiter = boundary?.[1] ?? boundary?.[2];
    if (!delimiter || !raw.includes(Buffer.from(`--${delimiter}--`)))
      throw new Error('Truncated or malformed MIME multipart message');
  }
  const parsed = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const address = (value: typeof parsed.to): string =>
    Array.isArray(value) ? value.map((item) => item.text).join(', ') : (value?.text ?? '');
  return validateEmail({
    subject: parsed.subject ?? '',
    sender: parsed.from?.text ?? '',
    recipients: address(parsed.to),
    cc: address(parsed.cc),
    sentAt:
      parsed.date && !Number.isNaN(parsed.date.valueOf())
        ? parsed.date.toISOString()
        : String(parsed.headers.get('date') ?? ''),
    html: parsed.html || '',
    text: parsed.text ?? '',
    attachments: parsed.attachments.map((attachment) => ({
      name: attachment.filename ?? '(unnamed attachment)',
      contentType: attachment.contentType,
      contentId: normalizeCid(attachment.contentId ?? ''),
      hidden: /application\/(?:x-)?pkcs7-signature/i.test(attachment.contentType),
      // Only resources actually embedded by the sanitizer are treated as
      // inline; retain unreferenced images and inline-disposition documents.
      inline: false,
      data: attachment.content,
    })),
  });
}
export async function parseEmailBytes(raw: Buffer, extension: string): Promise<NormalizedEmail> {
  if (raw.byteLength > LIMITS.inputBytes) throw new Error('Input exceeds the 100 MiB limit');
  return extension.toLowerCase() === '.msg' ? parseMsg(raw) : parseEml(raw);
}
export async function parseEmailFile(path: string): Promise<NormalizedEmail> {
  if ((await stat(path)).size > LIMITS.inputBytes)
    throw new Error('Input exceeds the 100 MiB limit');
  return parseEmailBytes(await readFile(path), extname(path));
}
