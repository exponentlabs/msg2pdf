import { File, FileSpreadsheet, FileText, Folder, Mail, Presentation } from 'lucide-react';
import { extension } from '../format';

export function FileIcon({ name, directory = false }: { name: string; directory?: boolean }) {
  const ext = extension(name);
  const kind = directory
    ? 'folder'
    : ['msg', 'eml'].includes(ext)
      ? 'email'
      : ext === 'pdf'
        ? 'pdf'
        : ['xls', 'xlsx', 'xlsm', 'xlsb'].includes(ext)
          ? 'sheet'
          : ['ppt', 'pptx', 'pptm'].includes(ext)
            ? 'slides'
            : 'document';
  const Icon = (
    {
      folder: Folder,
      email: Mail,
      pdf: FileText,
      sheet: FileSpreadsheet,
      slides: Presentation,
      document: File,
    } as const
  )[kind];
  return (
    <span className="file-icon" data-kind={kind}>
      <Icon size={19} strokeWidth={1.7} />
    </span>
  );
}
