import { ArrowUpRight, Paperclip, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { EmailPreview } from '../../shared/contracts';

export function PreviewDialog({
  preview,
  onClose,
}: {
  preview: EmailPreview;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="preview-dialog"
      onClose={onClose}
      aria-labelledby="preview-heading"
    >
      <div className="preview-top">
        <div>
          <span className="eyebrow">EMAIL PREVIEW</span>
          <h2 id="preview-heading">{preview.subject || '(no subject)'}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close preview"
          onClick={() => dialog.current?.close()}
        >
          <X size={20} />
        </button>
      </div>
      <div className="preview-meta">
        <span>
          <Paperclip size={14} /> {preview.attachmentCount} attachments
        </span>
        <span>
          Safe, offline preview <ArrowUpRight size={13} />
        </span>
      </div>
      <iframe
        title="Sanitised email preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={preview.html}
      />
    </dialog>
  );
}
