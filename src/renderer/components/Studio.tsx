import { useEffect, useMemo, useRef, useState } from 'react';
import { inversePoint, transformRectangle } from '../../core/studio/geometry';
import type { Rectangle, SnapshotPage, StudioView } from '../../shared/studio';
import type { Plan } from '../../shared/studio-domain';
import './Studio.css';

type Page = Omit<SnapshotPage, 'referenceRgb'>;
export function Studio() {
  const [view, setView] = useState<StudioView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [pages, setPages] = useState<Page[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [reason, setReason] = useState('Personal information');
  const [phrase, setPhrase] = useState('');
  const [hits, setHits] = useState<{ id: string; page: number; rect: Rectangle; text: string }[]>(
    [],
  );
  const [chosenHits, setChosenHits] = useState<number[]>([]);
  const [undo, setUndo] = useState<Plan['marks'][]>([]);
  const [redo, setRedo] = useState<Plan['marks'][]>([]);
  const drag = useRef<[number, number] | undefined>(undefined);
  const image = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const state = view?.case?.state;
  const document = state?.documents.find((item) => item.id === selected);
  const currentPage = pages[pageIndex];
  async function action(callback: () => Promise<StudioView>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const result = await callback();
      setView(result);
      if (!result.case) {
        setSelected('');
        setPages([]);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : 'The operation failed.',
      );
      try {
        setView(await window.studio.status());
      } catch {
        /* Keep the last known view for diagnostics. */
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void window.studio
      .status()
      .then(setView)
      .catch(() =>
        setView({
          available: false,
          reason: 'The studio is currently qualified for Fedora ARM64.',
          profile: 'fedora-raster-v1',
        }),
      );
  }, []);
  const documentId = document?.id;
  const revisionHash = document?.revision?.hash;
  const snapshotHash = document?.revision?.snapshotHash;
  const currentText = useMemo(
    () => currentPage?.text.map((item) => ({ ...item, id: crypto.randomUUID() })) ?? [],
    [currentPage],
  );
  useEffect(() => {
    let active = true;
    setPages([]);
    setPageIndex(0);
    setHits([]);
    setChosenHits([]);
    setUndo([]);
    setRedo([]);
    if (documentId && revisionHash && snapshotHash)
      void window.studio
        .snapshot({ id: documentId, revisionHash, snapshotHash })
        .then((snapshot) => {
          if (active) setPages(snapshot.pages);
        })
        .catch((cause: unknown) => {
          if (active)
            setError(cause instanceof Error ? cause.message : 'Could not open fixed pages.');
        });
    return () => {
      active = false;
    };
  }, [documentId, revisionHash, snapshotHash]);
  const version = state?.version ?? 0;
  const marks = document?.plan?.marks ?? [];
  async function save(next: Plan['marks'], history = true): Promise<void> {
    if (!document?.revision) return;
    if (history) {
      setUndo((items) => [...items, marks]);
      setRedo([]);
    }
    await action(() =>
      window.studio.saveMarks({
        id: document.id,
        version,
        revisionHash: document.revision?.hash ?? '',
        marks: next,
      }),
    );
  }
  function coordinate(event: React.PointerEvent): [number, number] | null {
    const bounds = image.current?.getBoundingClientRect();
    if (!bounds || !currentPage) return null;
    return [
      Math.max(0, Math.min(currentPage.width, (event.clientX - bounds.left) / zoom)),
      Math.max(0, Math.min(currentPage.height, (event.clientY - bounds.top) / zoom)),
    ];
  }
  async function finishDrag(event: React.PointerEvent): Promise<void> {
    const start = drag.current;
    drag.current = undefined;
    const end = coordinate(event);
    if (
      !start ||
      !end ||
      !currentPage ||
      Math.abs(end[0] - start[0]) < 2 ||
      Math.abs(end[1] - start[1]) < 2
    )
      return;
    const first = inversePoint(currentPage.transform, start[0], start[1]);
    const last = inversePoint(currentPage.transform, end[0], end[1]);
    const crop = currentPage.info.cropBox;
    const rect: Rectangle = [
      Math.max(crop[0], Math.min(first[0], last[0])),
      Math.max(crop[1], Math.min(first[1], last[1])),
      Math.min(crop[2], Math.max(first[0], last[0])),
      Math.min(crop[3], Math.max(first[1], last[1])),
    ];
    await save([
      ...marks,
      {
        id: crypto.randomUUID(),
        page: pageIndex,
        rect,
        reason: reason.trim() || 'Personal information',
        origin: 'manual',
      },
    ]);
  }
  async function markText(): Promise<void> {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !currentPage || !text.current) return;
    const range = selection.getRangeAt(0);
    const next = [...marks];
    text.current.querySelectorAll('[data-item]').forEach((node) => {
      if (!range.intersectsNode(node)) return;
      const index = Number(node.getAttribute('data-item'));
      const item = currentPage.text[index];
      if (item)
        next.push({
          id: crypto.randomUUID(),
          page: pageIndex,
          rect: item.rect,
          reason: reason.trim() || 'Personal information',
          origin: 'manual',
        });
    });
    selection.removeAllRanges();
    if (next.length !== marks.length) await save(next);
  }
  return (
    <div className="page-body studio">
      <div className="studio-heading">
        <div>
          <h1>Redaction studio</h1>
          <p>A local working folder. Fixed pages. Explicit review before sharing.</p>
        </div>
        <div className="studio-actions">
          <button
            type="button"
            disabled={busy || !view?.available}
            onClick={() => void action(() => window.studio.create())}
          >
            New working folder
          </button>
          <button
            type="button"
            disabled={busy || !view?.available}
            onClick={() => void action(() => window.studio.open())}
          >
            Open working folder
          </button>
          {state && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void action(() => window.studio.backup())}
              >
                Back up case
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void action(() => window.studio.close())}
              >
                Close case
              </button>
            </>
          )}
          {busy && (
            <button type="button" onClick={() => void window.studio.cancel()}>
              Cancel
            </button>
          )}
        </div>
      </div>
      {!view?.available && (
        <p role="status">{view?.reason ?? 'Checking local studio prerequisites…'}</p>
      )}
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      <p className="studio-profile">
        The initial profile exports image-only PDFs. Searchable text, accessibility tags, forms,
        attachments, source metadata and signatures are removed. Originals stay private in the
        working folder.
      </p>
      {state && (
        <>
          <div className="studio-case">
            <h2>{view?.case?.label}</h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => void action(() => window.studio.import())}
            >
              Add PDFs
            </button>
            <span aria-live="polite">
              {busy ? 'Working…' : 'Saved'} · {state.documents.length} documents
            </span>
          </div>
          <div className="studio-stages">
            <section>
              <h2>Exported</h2>
              <p>{state.documents.filter((item) => !item.revision).length} captured originals</p>
            </section>
            <section>
              <h2>For Redaction</h2>
              <p>{state.documents.filter((item) => item.revision).length} fixed revisions</p>
            </section>
            <section>
              <h2>Redacted for sharing</h2>
              <p>No approved release yet</p>
            </section>
          </div>
          <div className="studio-workspace">
            <aside className="studio-documents" aria-label="Case documents">
              {state.documents.map((item) => (
                <div key={item.id}>
                  <button
                    type="button"
                    aria-pressed={selected === item.id}
                    onClick={() => setSelected(item.id)}
                  >
                    {view?.case?.names[item.id]}
                    <small>
                      {item.failure
                        ? 'Blocked'
                        : item.revision
                          ? `${item.plan?.reviewedPages.length ?? 0}/${item.revision.pages.length} pages reviewed`
                          : 'Unprepared'}
                    </small>
                  </button>
                  {!item.revision && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setSelected(item.id);
                        void action(() => window.studio.prepare({ id: item.id, version }));
                      }}
                    >
                      Prepare fixed pages
                    </button>
                  )}
                </div>
              ))}
            </aside>
            <section className="studio-review" aria-label="PDF review">
              {document?.revision && currentPage ? (
                <>
                  <div className="studio-actions">
                    <button
                      type="button"
                      disabled={pageIndex === 0}
                      onClick={() => setPageIndex(pageIndex - 1)}
                    >
                      Previous page
                    </button>
                    <span>
                      Page {pageIndex + 1} of {pages.length}
                    </span>
                    <button
                      type="button"
                      disabled={pageIndex + 1 >= pages.length}
                      onClick={() => setPageIndex(pageIndex + 1)}
                    >
                      Next page
                    </button>
                    <label>
                      Zoom{' '}
                      <select
                        value={zoom}
                        onChange={(event) => setZoom(Number(event.target.value))}
                      >
                        <option value={0.5}>50%</option>
                        <option value={1}>100%</option>
                        <option value={1.5}>150%</option>
                        <option value={2}>200%</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          window.studio.reviewPage({
                            id: document.id,
                            version,
                            revisionHash: document.revision?.hash ?? '',
                            page: pageIndex,
                            decision: document.plan?.reviewedPages.includes(pageIndex)
                              ? 'unreviewed'
                              : 'reviewed',
                          }),
                        )
                      }
                    >
                      {document.plan?.reviewedPages.includes(pageIndex)
                        ? 'Mark page unreviewed'
                        : 'Mark page reviewed'}
                    </button>
                  </div>
                  <p>
                    Drag over the fixed page to mark a region. Review every page, including pages
                    needing no marks.
                  </p>
                  <label>
                    Redaction reason{' '}
                    <input
                      value={reason}
                      maxLength={200}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <div className="studio-canvas-scroll">
                    <div
                      ref={image}
                      className="studio-canvas"
                      role="application"
                      aria-label="Drag to mark redaction regions"
                      style={{ width: currentPage.width * zoom, height: currentPage.height * zoom }}
                      onPointerDown={(event) => {
                        if (!busy) {
                          drag.current = coordinate(event) ?? undefined;
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }
                      }}
                      onPointerUp={(event) => {
                        if (!busy) void finishDrag(event);
                      }}
                      onPointerCancel={() => {
                        drag.current = undefined;
                      }}
                    >
                      <img
                        src={`data:image/png;base64,${currentPage.png}`}
                        alt={`Fixed review page ${pageIndex + 1}`}
                        draggable={false}
                      />
                      {marks
                        .filter((mark) => mark.page === pageIndex)
                        .map((mark) => {
                          const [x1, y1, x2, y2] = transformRectangle(
                            currentPage.transform,
                            mark.rect,
                          );
                          return (
                            <div
                              key={mark.id}
                              className="studio-mark"
                              style={{
                                left: x1 * zoom,
                                top: y1 * zoom,
                                width: (x2 - x1) * zoom,
                                height: (y2 - y1) * zoom,
                              }}
                            />
                          );
                        })}
                    </div>
                  </div>
                  <div className="studio-actions">
                    <button
                      type="button"
                      disabled={busy || !undo.length}
                      onClick={() => {
                        const previous = undo.at(-1);
                        if (previous) {
                          setRedo((items) => [...items, marks]);
                          setUndo((items) => items.slice(0, -1));
                          void save(previous, false);
                        }
                      }}
                    >
                      Undo marks
                    </button>
                    <button
                      type="button"
                      disabled={busy || !redo.length}
                      onClick={() => {
                        const next = redo.at(-1);
                        if (next) {
                          setUndo((items) => [...items, marks]);
                          setRedo((items) => items.slice(0, -1));
                          void save(next, false);
                        }
                      }}
                    >
                      Redo marks
                    </button>
                    <button
                      type="button"
                      disabled={busy || !marks.some((mark) => mark.page === pageIndex)}
                      onClick={() => void save(marks.filter((mark) => mark.page !== pageIndex))}
                    >
                      Clear page marks
                    </button>
                  </div>
                  <details>
                    <summary>Text lines and exact-phrase search</summary>
                    <p>
                      Select text below, then add its full line bounds as visible marks on the page.
                    </p>
                    <div ref={text} className="studio-text">
                      {currentPage.text.length ? (
                        currentText.map((item, index) => (
                          <span key={item.id} data-item={index}>
                            {item.text}
                            {'\n'}
                          </span>
                        ))
                      ) : (
                        <p>This page has no selectable text. Use manual regions.</p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busy || !currentPage.text.length}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => void markText()}
                    >
                      Mark selected text lines
                    </button>
                    <label>
                      Exact phrase{' '}
                      <input
                        value={phrase}
                        maxLength={200}
                        onChange={(event) => setPhrase(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !phrase}
                      onClick={() => {
                        setError('');
                        void window.studio
                          .search({
                            id: document.id,
                            revisionHash: document.revision?.hash ?? '',
                            phrase,
                          })
                          .then((result) => {
                            setHits(result.map((hit) => ({ ...hit, id: crypto.randomUUID() })));
                            setChosenHits([]);
                          })
                          .catch((cause: unknown) =>
                            setError(cause instanceof Error ? cause.message : 'Search failed.'),
                          );
                      }}
                    >
                      Find matches
                    </button>
                    <p>{hits.length} matching text regions. Select the matches to add.</p>
                    {hits.map((hit, index) => (
                      <label className="studio-hit" key={hit.id}>
                        <input
                          type="checkbox"
                          checked={chosenHits.includes(index)}
                          onChange={(event) =>
                            setChosenHits((items) =>
                              event.target.checked
                                ? [...items, index]
                                : items.filter((value) => value !== index),
                            )
                          }
                        />
                        Page {hit.page + 1}: {hit.text}
                      </label>
                    ))}
                    <button
                      type="button"
                      disabled={busy || !chosenHits.length}
                      onClick={() => {
                        void save([
                          ...marks,
                          ...chosenHits.flatMap((index) => {
                            const hit = hits[index];
                            return hit
                              ? [
                                  {
                                    id: crypto.randomUUID(),
                                    page: hit.page,
                                    rect: hit.rect,
                                    reason: reason.trim() || 'Personal information',
                                    origin: 'search' as const,
                                  },
                                ]
                              : [];
                          }),
                        ]);
                        setChosenHits([]);
                      }}
                    >
                      Add selected match regions
                    </button>
                  </details>
                  <ul className="studio-mark-list" aria-label="Redaction marks">
                    {marks.map((mark) => (
                      <li key={mark.id}>
                        Page {mark.page + 1} · {mark.reason}{' '}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void save(marks.filter((item) => item.id !== mark.id))}
                        >
                          Remove mark
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>
                  {document
                    ? 'Prepare this document to review its fixed pages.'
                    : 'Choose a document to start reviewing.'}
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
