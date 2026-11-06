import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Eye,
  Folder,
  FolderOpen,
  Info,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  Square,
  Upload,
  X,
} from 'lucide-react';
import type { DragEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { extension, folderName, formatBytes, formatDuration } from '../format';
import type { Workbench as WorkbenchState } from '../useWorkbench';
import { FileIcon } from './FileIcon';
import { Toggle } from './Toggle';

const PAGE_SIZE = 40;
export function Workbench({
  workbench: w,
  openSettings,
}: {
  workbench: WorkbenchState;
  openSettings: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const files = w.plan?.files ?? [];
    const search = query.trim().toLowerCase();
    return search
      ? files.filter((file) => file.relativeName.toLowerCase().includes(search))
      : files;
  }, [w.plan, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const officeCount = w.plan?.files.filter((file) => file.kind === 'office').length ?? 0;
  const supportedCount = w.plan?.files.filter((file) => file.kind !== 'unsupported').length ?? 0;
  const needsOffice = officeCount > 0 && !w.info?.office.available;
  const ready =
    w.inputs.length > 0 &&
    w.output !== null &&
    !w.planning &&
    !w.planError &&
    supportedCount > 0 &&
    !needsOffice;
  const total = w.plan?.files.length ?? 0;
  const canPreview = (name: string): boolean => ['msg', 'eml'].includes(extension(name));
  function drop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!w.busy) void w.drop(Array.from(event.dataTransfer.files));
  }
  return (
    <>
      <div className="page-body converter-page">
        <div className="hero">
          <div>
            <span className="eyebrow">A LITTLE LESS ADMIN</span>
            <h1>
              Emails in. PDFs out<span>.</span>
            </h1>
            <p>Your messages and documents, neatly converted. All on your device.</p>
          </div>
          <span className="hero-emblem" aria-hidden="true">
            <FileIcon name="message.eml" />
            <ArrowRight size={18} />
            <FileIcon name="archive.pdf" />
          </span>
        </div>
        <div className="converter-grid">
          <section className="panel input-panel" aria-labelledby="inputs-heading">
            <div className="panel-heading">
              <div>
                <span className="step-label">01 &nbsp; YOUR FILES</span>
                <h2 id="inputs-heading">What are we converting?</h2>
              </div>
              <div className="input-actions">
                <button
                  type="button"
                  className="button small secondary"
                  disabled={w.busy}
                  onClick={() => void w.choose('files')}
                >
                  <Plus size={15} /> Add files
                </button>
                <button
                  type="button"
                  className="icon-button outlined"
                  disabled={w.busy}
                  aria-label="Add a folder"
                  title="Add a folder"
                  onClick={() => void w.choose('directory')}
                >
                  <Folder size={17} />
                </button>
              </div>
            </div>
            <button
              type="button"
              className={`dropzone ${w.inputs.length ? 'compact' : ''} ${dragging ? 'dragging' : ''}`}
              disabled={w.busy}
              onClick={() => void w.choose('files')}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={drop}
              onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current++;
                setDragging(true);
              }}
              onDragLeave={() => {
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (!dragDepth.current) setDragging(false);
              }}
            >
              <span className="drop-icon">
                <Upload size={25} strokeWidth={1.6} />
              </span>
              <span className="drop-title">
                {dragging
                  ? 'Drop them right here'
                  : w.inputs.length
                    ? 'There’s room for more'
                    : 'Drop files or a folder here'}
              </span>
              <span className="drop-caption">
                or <span>browse your files</span> to get started
              </span>
              {!w.inputs.length && (
                <span className="format-tags">
                  <span>MSG</span>
                  <span>EML</span>
                  <span>PDF</span>
                  <span>OFFICE</span>
                </span>
              )}
            </button>
            {w.inputs.length > 0 && (
              <div className="selection-strip">
                <span>
                  {w.inputs.length} {w.inputs.length === 1 ? 'source' : 'sources'} selected
                </span>
                <button type="button" className="text-button" disabled={w.busy} onClick={w.clear}>
                  Clear all
                </button>
                <div className="source-chips">
                  {w.inputs.map((input) => (
                    <span className="source-chip" key={input.id} title={input.path}>
                      {input.kind === 'directory' ? <Folder size={12} /> : null}
                      <span>{input.name}</span>
                      <button
                        type="button"
                        disabled={w.busy}
                        aria-label={`Remove ${input.name}`}
                        onClick={() => w.remove(input.id)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {w.planning && (
              <div className="planning-state" role="status">
                <LoaderCircle className="spin" size={17} /> Reading your folder structure…
              </div>
            )}
            {w.planError && (
              <div className="inline-error plan-error" role="alert">
                <CircleAlert size={17} />
                <span>{w.planError}</span>
              </div>
            )}
            {w.inputs.length > 0 && !w.output && (
              <div className="choose-output-hint">
                <ArrowRight size={16} /> Choose an output folder to prepare your conversion.
              </div>
            )}
            {w.plan && !w.planning && (
              <>
                <div className="queue-toolbar">
                  <span>
                    {total} {total === 1 ? 'file' : 'files'}
                    <span className="muted-dot">·</span>
                    {formatBytes(w.plan.totalBytes)}
                  </span>
                  <label className="queue-search">
                    <Search size={14} />
                    <input
                      aria-label="Search file queue"
                      placeholder="Find a file…"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.currentTarget.value);
                        setPage(0);
                      }}
                    />
                  </label>
                </div>
                <ul className="file-queue" aria-label="Conversion queue">
                  {visible.map((file) => {
                    const result = w.results.current.get(file.id);
                    const status =
                      file.id === w.activeId
                        ? 'working'
                        : (result?.status ??
                          (file.kind === 'unsupported' ? 'unsupported' : 'queued'));
                    return (
                      <li className="file-row" data-status={status} key={file.id}>
                        <FileIcon name={file.name} />
                        <div className="file-details">
                          <span className="file-name" title={file.relativeName}>
                            {file.name}
                          </span>
                          <span className="file-subtitle" title={file.relativeName}>
                            {file.relativeName !== file.name
                              ? file.relativeName
                              : `${extension(file.name).toUpperCase()} file`}
                            <span>·</span>
                            {formatBytes(file.size)}
                          </span>
                          {result?.error && (
                            <details className="error-details">
                              <summary>View error</summary>
                              <p>{result.error}</p>
                            </details>
                          )}
                        </div>
                        <div className="file-end">
                          <span className="file-status">
                            {status === 'working' ? (
                              <>
                                <LoaderCircle size={13} className="spin" /> Converting
                              </>
                            ) : status === 'converted' || status === 'copied' ? (
                              <>
                                <Check size={14} /> {status === 'copied' ? 'Copied' : 'Done'}
                              </>
                            ) : status === 'failed' || status === 'partial' ? (
                              <>
                                <CircleAlert size={14} />{' '}
                                {status === 'partial' ? 'Check attachments' : 'Failed'}
                              </>
                            ) : status === 'cancelled' ? (
                              <span>Stopped</span>
                            ) : status === 'skipped' ? (
                              'Skipped'
                            ) : status === 'unsupported' ? (
                              'Not supported'
                            ) : (
                              'Ready'
                            )}
                          </span>
                          {canPreview(file.name) && (
                            <button
                              type="button"
                              className="icon-button preview-button"
                              aria-label={`Preview ${file.name}`}
                              disabled={w.busy || w.previewing}
                              onClick={() => void w.openPreview(file.id)}
                            >
                              <Eye size={16} />
                            </button>
                          )}
                          {result && ['converted', 'copied', 'partial'].includes(result.status) && (
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Reveal ${file.name}`}
                              onClick={() =>
                                void w.attempt(() => window.desktop.openResult(file.id))
                              }
                            >
                              <FolderOpen size={15} />
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {filtered.length === 0 && (
                    <li className="queue-empty">
                      {query
                        ? 'No files match your search.'
                        : 'No matching files in this selection. Try including subfolders or Office files.'}
                    </li>
                  )}
                </ul>
                {pages > 1 && (
                  <div className="pagination">
                    <span>
                      {currentPage * PAGE_SIZE + 1}–
                      {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of{' '}
                      {filtered.length}
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Previous page"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Next page"
                      disabled={currentPage >= pages - 1}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
                {w.plan.issues.length > 0 && (
                  <details className="discovery-issues">
                    <summary>
                      <CircleAlert size={14} /> {w.plan.issues.length} discovery{' '}
                      {w.plan.issues.length === 1 ? 'issue' : 'issues'} — included in failure counts
                    </summary>
                    {w.plan.issues.map((issue) => (
                      <p key={`${issue.path}:${issue.message}`}>
                        <strong>{issue.path}</strong> {issue.message}
                      </p>
                    ))}
                  </details>
                )}
              </>
            )}
            {!w.inputs.length && (
              <div className="input-footnote">
                <ShieldCheck size={14} />
                <span>Original files stay untouched. No uploads, ever.</span>
              </div>
            )}
          </section>
          <aside className="conversion-sidebar">
            <section className="panel output-panel">
              <span className="step-label">02 &nbsp; DESTINATION</span>
              <h2>A place for your PDFs</h2>
              <button
                type="button"
                className={`destination-picker ${w.output ? 'selected' : ''}`}
                disabled={w.busy}
                onClick={() => void w.chooseOutput()}
              >
                <span className="destination-icon">
                  <FolderOpen size={21} strokeWidth={1.6} />
                </span>
                <span>
                  <strong>{w.output ? folderName(w.output.path) : 'Choose output folder'}</strong>
                  <small title={w.output?.path}>
                    {w.output?.path ?? 'Your converted files will live here'}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
              {w.output && (
                <p className="fine-print">Existing files are kept unless you enable overwrite.</p>
              )}
            </section>
            <section className="panel options-panel">
              <span className="step-label">03 &nbsp; THE DETAILS</span>
              <h2>Make it yours</h2>
              <div className="options-list">
                <Toggle
                  label="Include subfolders"
                  description="Keep your folder structure"
                  checked={w.options.recursive}
                  disabled={w.busy}
                  onChange={(recursive) => w.changeOptions({ recursive })}
                />
                <Toggle
                  label="Extract attachments"
                  description="Save ordinary attachments alongside"
                  checked={w.options.extractAttachments}
                  disabled={w.busy}
                  onChange={(extractAttachments) => w.changeOptions({ extractAttachments })}
                />
                <Toggle
                  label="Include Office files & PDFs"
                  description="For folders with a bit of everything"
                  checked={w.options.allToPdf}
                  disabled={w.busy}
                  onChange={(allToPdf) => w.changeOptions({ allToPdf })}
                />
                <Toggle
                  label="Overwrite existing files"
                  description="Replace previous conversion outputs"
                  checked={w.options.overwrite}
                  disabled={w.busy}
                  onChange={(overwrite) => w.changeOptions({ overwrite })}
                />
              </div>
              <div className="page-size-row">
                <label htmlFor="page-size">Page size</label>
                <select
                  id="page-size"
                  value={w.options.pageSize}
                  disabled={w.busy}
                  onChange={(event) =>
                    w.changeOptions({
                      pageSize: event.currentTarget.value === 'Letter' ? 'Letter' : 'A4',
                    })
                  }
                >
                  <option value="A4">A4 · 210 × 297 mm</option>
                  <option value="Letter">Letter · 8.5 × 11 in</option>
                </select>
              </div>
            </section>
            <button
              type="button"
              className={`office-note ${needsOffice ? 'attention' : ''}`}
              onClick={openSettings}
            >
              <span className="office-note-icon">
                {needsOffice ? <CircleAlert size={18} /> : <Info size={18} />}
              </span>
              <span>
                <strong>
                  {w.info?.office.available
                    ? `LibreOffice ${w.info.office.version} connected`
                    : needsOffice
                      ? `${officeCount} Office ${officeCount === 1 ? 'file needs' : 'files need'} LibreOffice`
                      : 'Working with Office files?'}
                </strong>
                <small>
                  {w.info?.office.available
                    ? 'Office conversion is ready when you are.'
                    : 'Connect LibreOffice in Settings.'}
                </small>
              </span>
              <ChevronRight size={15} />
            </button>
          </aside>
        </div>
        {w.summary && (
          <section
            className={`result-card ${w.summary.failed || w.summary.cancelled ? 'partial' : ''}`}
            aria-live="polite"
          >
            <span className="result-mark">
              {w.summary.failed || w.summary.cancelled ? (
                <CircleAlert size={24} />
              ) : (
                <Check size={25} />
              )}
            </span>
            <div>
              <h2>
                {w.summary.cancelled
                  ? 'Stopped. Your completed files are safe.'
                  : w.summary.failed
                    ? 'Finished, with a few things to check.'
                    : 'A tidy little archive. All done.'}
              </h2>
              <p>
                {w.summary.converted + w.summary.copied} PDFs written · {w.summary.attachments}{' '}
                attachments · {w.summary.skipped} skipped
                {w.summary.failed ? ` · ${w.summary.failed} failed` : ''} ·{' '}
                {formatDuration(w.summary.startedAt, w.summary.finishedAt)}
              </p>
            </div>
            <button
              type="button"
              className="button secondary small"
              onClick={() => void w.attempt(() => window.desktop.exportReport())}
            >
              <ArrowDownToLine size={15} /> Export report
            </button>
          </section>
        )}
        <div className="workspace-footnote">
          <ShieldCheck size={13} />
          <span>Processed privately, right here.</span>
          <span className="footnote-separator">/</span>
          <span>No account. No cloud. Just PDFs.</span>
        </div>
      </div>
      <footer className="conversion-footer">
        <div className="footer-status" role="status">
          {w.busy ? (
            <>
              <LoaderCircle size={18} className="spin" />
              <div>
                <strong>Making your PDFs</strong>
                <span>
                  {w.completed} of {total} files processed
                </span>
                <progress
                  value={w.completed}
                  max={Math.max(total, 1)}
                  aria-label="Conversion progress"
                />
              </div>
            </>
          ) : (
            <>
              <span className={`ready-dot ${ready || w.summary ? 'is-ready' : ''}`} />
              <div>
                <strong>
                  {w.summary
                    ? w.summary.cancelled
                      ? 'Your batch was stopped'
                      : w.summary.failed
                        ? 'Completed with issues'
                        : 'Your batch is complete'
                    : w.planning
                      ? 'Preparing your batch…'
                      : supportedCount
                        ? `${supportedCount} ${supportedCount === 1 ? 'file' : 'files'} ready to convert`
                        : 'A clean start'}
                </strong>
                <span>
                  {w.summary
                    ? 'Open your output folder or start another batch.'
                    : needsOffice
                      ? 'Connect LibreOffice to convert this batch.'
                      : w.output
                        ? 'Your output folder is set.'
                        : 'Add your files and choose a destination.'}
                </span>
              </div>
            </>
          )}
        </div>
        <div className="footer-actions">
          {w.busy ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => void w.attempt(() => window.desktop.cancel())}
            >
              <Square size={13} /> Stop conversion
            </button>
          ) : w.summary ? (
            <>
              <button type="button" className="button secondary" onClick={w.clear}>
                <Plus size={16} /> New batch
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void w.attempt(() => window.desktop.revealOutput())}
              >
                <FolderOpen size={16} /> Open output folder <ArrowRight size={16} />
              </button>
            </>
          ) : (
            <>
              <span className="shortcut-hint">
                <kbd>{w.info?.platform === 'darwin' ? '⌘' : 'Ctrl'}</kbd>
                <kbd>↵</kbd>
              </span>
              <button
                type="button"
                className="button primary convert-button"
                disabled={!ready}
                onClick={() => void w.convert()}
              >
                Convert to PDF <ArrowRight size={17} />
              </button>
            </>
          )}
        </div>
      </footer>
    </>
  );
}
