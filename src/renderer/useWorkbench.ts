import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppInfo,
  BatchSummary,
  ConversionOptions,
  ConversionPlan,
  EmailPreview,
  FileResult,
  GuiRequest,
  InputSelection,
  OutputSelection,
} from '../shared/contracts';
import { optionsSchema } from '../shared/contracts';
import { humanError } from './format';

function initialOptions(): ConversionOptions {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('conversion-options') ?? 'null');
    const parsed = optionsSchema.safeParse(saved);
    if (parsed.success) return parsed.data;
  } catch {
    /* Invalid local preferences use safe defaults. */
  }
  return {
    recursive: true,
    extractAttachments: false,
    allToPdf: true,
    overwrite: false,
    pageSize: 'A4',
  };
}
export function useWorkbench() {
  const [inputs, setInputs] = useState<InputSelection[]>([]);
  const [output, setOutput] = useState<OutputSelection | null>(null);
  const [options, setOptions] = useState(initialOptions);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [plan, setPlan] = useState<ConversionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const results = useRef(new Map<string, FileResult>());
  const request = useCallback((): GuiRequest => {
    if (!output || !inputs.length)
      throw new Error('Choose your input files and output folder first');
    return { inputIds: inputs.map((input) => input.id), outputId: output.id, options };
  }, [inputs, output, options]);
  const attempt = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(humanError(caught));
      return undefined;
    }
  }, []);
  useEffect(() => {
    window.desktop
      .info()
      .then(setInfo)
      .catch((caught: unknown) => setError(humanError(caught)));
    window.desktop
      .history()
      .then(setHistory)
      .catch((caught: unknown) => setError(humanError(caught)));
    return window.desktop.onProgress((event) => {
      if (event.type === 'plan') {
        setPlan(event.plan);
        results.current.clear();
        setCompleted(0);
        setSummary(null);
      }
      if (event.type === 'file-start') setActiveId(event.id);
      if (event.type === 'file-complete') {
        results.current.set(event.result.id, event.result);
        setCompleted((value) => value + 1);
        setActiveId(null);
      }
      if (event.type === 'complete') {
        setSummary(event.summary);
        setBusy(false);
        setActiveId(null);
        window.desktop
          .history()
          .then(setHistory)
          .catch((caught: unknown) => setError(humanError(caught)));
      }
    });
  }, []);
  useEffect(() => {
    localStorage.setItem('conversion-options', JSON.stringify(options));
  }, [options]);
  useEffect(() => {
    if (busy || summary || !inputs.length || !output) return;
    let cancelled = false;
    setPlanning(true);
    setPlanError(null);
    const timer = setTimeout(() => {
      window.desktop
        .plan(request())
        .then((next) => {
          if (!cancelled) {
            setPlan(next);
            setPlanning(false);
          }
        })
        .catch((caught: unknown) => {
          if (!cancelled) {
            setPlan(null);
            setPlanError(humanError(caught));
            setPlanning(false);
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [request, inputs.length, output, busy, summary]);
  const reset = useCallback(() => {
    setSummary(null);
    setPlan(null);
    results.current.clear();
    setCompleted(0);
    setPlanError(null);
  }, []);
  const add = useCallback(
    (selected: InputSelection[]) => {
      if (!selected.length) return;
      reset();
      setInputs((current) => [
        ...new Map([...current, ...selected].map((item) => [item.id, item])).values(),
      ]);
    },
    [reset],
  );
  const choose = useCallback(
    (kind: 'files' | 'directory') =>
      attempt(async () => add(await window.desktop.chooseInputs(kind))),
    [attempt, add],
  );
  const drop = useCallback(
    (files: File[]) => attempt(async () => add(await window.desktop.importDroppedFiles(files))),
    [attempt, add],
  );
  const chooseOutput = useCallback(
    () =>
      attempt(async () => {
        const selected = await window.desktop.chooseOutput();
        if (selected) {
          reset();
          setOutput(selected);
        }
      }),
    [attempt, reset],
  );
  const changeOptions = useCallback(
    (change: Partial<ConversionOptions>) => {
      reset();
      setOptions((current) => ({ ...current, ...change }));
    },
    [reset],
  );
  const remove = useCallback(
    (id: string) => {
      reset();
      setInputs((current) => current.filter((input) => input.id !== id));
    },
    [reset],
  );
  const clear = useCallback(() => {
    reset();
    setInputs([]);
  }, [reset]);
  const convert = useCallback(async () => {
    if (busy || planning || planError || !plan || !inputs.length || !output) return;
    if (!info?.office.available && plan.files.some((file) => file.kind === 'office')) {
      setError('Connect LibreOffice in Settings to convert this batch.');
      return;
    }
    setBusy(true);
    setError(null);
    setSummary(null);
    setCompleted(0);
    results.current.clear();
    try {
      await window.desktop.convert(request());
    } catch (caught) {
      setError(humanError(caught));
    } finally {
      setBusy(false);
      setActiveId(null);
    }
  }, [busy, planning, planError, plan, info, inputs.length, output, request]);
  const openPreview = useCallback(
    (id: string) =>
      attempt(async () => {
        setPreviewing(true);
        try {
          setPreview(await window.desktop.preview(id));
        } finally {
          setPreviewing(false);
        }
      }),
    [attempt],
  );
  const updateOffice = useCallback(
    (action: 'chooseOffice' | 'detectOffice') =>
      attempt(async () => {
        const office = await window.desktop[action]();
        setInfo((current) => (current ? { ...current, office } : null));
      }),
    [attempt],
  );
  return {
    inputs,
    output,
    options,
    info,
    plan,
    planning,
    planError,
    busy,
    completed,
    activeId,
    summary,
    history,
    error,
    preview,
    previewing,
    results,
    choose,
    drop,
    chooseOutput,
    changeOptions,
    remove,
    clear,
    convert,
    openPreview,
    updateOffice,
    attempt,
    clearError: () => setError(null),
    closePreview: () => setPreview(null),
    clearHistory: () =>
      attempt(async () => {
        await window.desktop.clearHistory();
        setHistory([]);
      }),
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
