import { extname } from 'node:path';
import type { FileKind } from '../shared/contracts';

export const EMAIL_EXTENSIONS = new Set(['.msg', '.eml']);
export const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.docm',
  '.dot',
  '.dotx',
  '.dotm',
  '.rtf',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.xlt',
  '.xltx',
  '.xltm',
  '.ppt',
  '.pptx',
  '.pptm',
  '.pps',
  '.ppsx',
  '.ppsm',
  '.pot',
  '.potx',
  '.potm',
]);
export function fileKind(name: string, allToPdf: boolean): FileKind {
  const extension = extname(name).toLowerCase();
  if (name.startsWith('~$')) return 'unsupported';
  if (EMAIL_EXTENSIONS.has(extension)) return 'email';
  if (allToPdf && extension === '.pdf') return 'pdf';
  if (allToPdf && OFFICE_EXTENSIONS.has(extension)) return 'office';
  return 'unsupported';
}
