import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clock,
  FolderOpen,
  History,
  Trash2,
} from 'lucide-react';
import { folderName, formatDuration } from '../format';
import type { Workbench } from '../useWorkbench';

export function Activity({ workbench: w }: { workbench: Workbench }) {
  return (
    <section className="activity-view">
      <div className="view-heading">
        <span className="eyebrow">YOUR PAPER TRAIL</span>
        <div className="heading-with-action">
          <h1>Recent activity</h1>
          {w.history.length > 0 && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void w.clearHistory()}
            >
              <Trash2 size={15} /> Clear history
            </button>
          )}
        </div>
        <p>A local record of your last 20 conversion batches.</p>
      </div>
      {!w.history.length ? (
        <div className="panel empty-history">
          <History size={34} strokeWidth={1.3} />
          <h2>A fresh start.</h2>
          <p>
            Your completed conversions will appear here.
            <br />
            File contents are never stored in history.
          </p>
        </div>
      ) : (
        <div className="history-list">
          {w.history.map((batch) => (
            <article className="panel history-card" key={batch.id}>
              <div className={`history-status ${batch.failed || batch.cancelled ? 'warning' : ''}`}>
                {batch.failed || batch.cancelled ? <CircleAlert size={22} /> : <Check size={22} />}
              </div>
              <div className="history-main">
                <h2>{folderName(batch.output)}</h2>
                <p>
                  {batch.converted + batch.copied} PDFs · {batch.attachments} attachments
                  {batch.failed ? ` · ${batch.failed} failed` : ''}
                  {batch.cancelled ? ' · Cancelled' : ''}
                </p>
                <span className="history-path" title={batch.output}>
                  <FolderOpen size={13} /> {batch.output}
                </span>
              </div>
              <div className="history-time">
                <span>
                  {new Date(batch.startedAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                <span>
                  <Clock size={12} /> {formatDuration(batch.startedAt, batch.finishedAt)}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
      {w.summary && (
        <button
          type="button"
          className="button secondary report-button"
          onClick={() => void w.attempt(() => window.desktop.exportReport())}
        >
          <ArrowDownToLine size={15} /> Export latest report
        </button>
      )}
      <p className="fine-print">
        History keeps the first 500 file results per batch. Export a report after conversion for the
        complete record.
      </p>
    </section>
  );
}
