import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { app, dialog, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { runConversion } from '../core/engine';
import { atomicWrite } from '../core/filesystem';
import { buildEmailHtml } from '../core/html';
import { detectOffice, LIBREOFFICE_DOWNLOAD_URL } from '../core/office';
import { createPlan } from '../core/planner';
import { CHANNELS } from '../shared/channels';
import type {
  BatchSummary,
  ConversionPlan,
  GuiRequest,
  InputSelection,
  OfficeStatus,
  OutputSelection,
} from '../shared/contracts';
import { guiRequestSchema, requestSchema } from '../shared/contracts';
import { originKey } from '../shared/security';
import { createServices, parseEmail } from './services';
import type { AppStore } from './store';

export function registerDesktopApi(
  window: BrowserWindow,
  store: AppStore,
  trustedOrigin: string,
): () => Promise<void> {
  const inputs = new Map<string, InputSelection>();
  let output: OutputSelection | null = null;
  let current: AbortController | null = null;
  let previewController: AbortController | null = null;
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  let latest: BatchSummary | null = null;
  let planned: ConversionPlan | null = null;
  let officePromise: Promise<OfficeStatus> | null = null;
  const getOffice = (): Promise<OfficeStatus> => {
    officePromise ??= store.officePath().then((path) => detectOffice(path));
    return officePromise;
  };
  const services = createServices(getOffice);
  const handlers: string[] = [];
  function trusted(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame;
    if (
      event.sender.id !== window.webContents.id ||
      !frame ||
      frame.parent !== null ||
      originKey(frame.url) !== trustedOrigin
    )
      throw new Error('Untrusted IPC sender');
  }
  function handle<T>(channel: string, schema: z.ZodType<T>, callback: (value: T) => unknown): void {
    handlers.push(channel);
    ipcMain.handle(channel, (event, value: unknown) => {
      trusted(event);
      if (closing) throw new Error('The app is closing');
      const task = Promise.resolve(callback(schema.parse(value)));
      // Native modal dialogs can remain open until Electron quits. Await only
      // worker jobs so shutdown cannot deadlock on an open file picker.
      if (channel === CHANNELS.convert || channel === CHANNELS.preview) pending.add(task);
      return task.finally(() => pending.delete(task));
    });
  }
  function idle(): void {
    if (current) throw new Error('A conversion is already running');
    if (previewController) throw new Error('A preview is already being prepared');
  }
  async function add(paths: string[]): Promise<InputSelection[]> {
    idle();
    const selected: InputSelection[] = [];
    for (const path of paths) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error('Select regular files or folders, not symbolic links');
      const canonical = await realpath(path);
      const existing = [...inputs.values()].find((item) => item.path === canonical);
      const selection: InputSelection = existing ?? {
        id: randomUUID(),
        name: basename(path),
        path: canonical,
        kind: info.isDirectory() ? 'directory' : 'file',
        size: info.size,
      };
      inputs.set(selection.id, selection);
      selected.push(selection);
    }
    return selected;
  }
  function request(value: GuiRequest) {
    if (!output || value.outputId !== output.id) throw new Error('Choose an output folder first');
    const paths = value.inputIds.map((id) => {
      const input = inputs.get(id);
      if (!input) throw new Error('Input selection has expired');
      return input.path;
    });
    return requestSchema.parse({ inputs: paths, output: output.path, options: value.options });
  }
  handle(CHANNELS.info, z.undefined(), async () => ({
    version: app.getVersion(),
    platform: process.platform,
    office: await getOffice(),
  }));
  handle(CHANNELS.chooseInputs, z.enum(['files', 'directory']), async (kind) => {
    idle();
    const result = await dialog.showOpenDialog(window, {
      title: kind === 'directory' ? 'Choose a folder to convert' : 'Choose files to convert',
      properties: kind === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      ...(kind === 'files'
        ? {
            filters: [
              {
                name: 'Emails and documents',
                extensions: [
                  'msg',
                  'eml',
                  'pdf',
                  'doc',
                  'docx',
                  'docm',
                  'dot',
                  'dotx',
                  'dotm',
                  'rtf',
                  'xls',
                  'xlsx',
                  'xlsm',
                  'xlsb',
                  'xlt',
                  'xltx',
                  'xltm',
                  'ppt',
                  'pptx',
                  'pptm',
                  'pps',
                  'ppsx',
                  'ppsm',
                  'pot',
                  'potx',
                  'potm',
                ],
              },
              { name: 'All files', extensions: ['*'] },
            ],
          }
        : {}),
    });
    return result.canceled ? [] : add(result.filePaths);
  });
  handle(CHANNELS.importPaths, z.array(z.string().min(1).max(32_768)).max(1_000), add);
  handle(CHANNELS.chooseOutput, z.undefined(), async () => {
    idle();
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose an output folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    output = { id: randomUUID(), path: await realpath(path) };
    return output;
  });
  handle(CHANNELS.plan, guiRequestSchema, async (value) => {
    idle();
    planned = await createPlan(request(value));
    return planned;
  });
  handle(CHANNELS.convert, guiRequestSchema, async (value) => {
    idle();
    const validated = request(value);
    current = new AbortController();
    try {
      const plan = await createPlan(validated, current.signal);
      planned = plan;
      latest = await runConversion(
        plan,
        services,
        (event) => {
          if (event.type !== 'complete' && !window.isDestroyed())
            window.webContents.send(CHANNELS.progress, event);
        },
        current.signal,
      );
      try {
        await store.record(latest);
      } catch (error) {
        console.error('Unable to save local conversion history', error);
      }
    } finally {
      current = null;
    }
    if (latest && !window.isDestroyed())
      window.webContents.send(CHANNELS.progress, { type: 'complete', summary: latest });
  });
  handle(CHANNELS.cancel, z.undefined(), () => current?.abort());
  handle(CHANNELS.preview, z.string().uuid(), async (id) => {
    idle();
    const selected = inputs.get(id);
    const nested = planned?.files.find((file) => file.id === id && file.kind === 'email');
    const input = selected ?? (nested ? { path: nested.source, kind: 'file' } : null);
    if (input?.kind !== 'file' || !['.msg', '.eml'].includes(extname(input.path).toLowerCase()))
      throw new Error('Select an MSG or EML file to preview');
    previewController = new AbortController();
    try {
      const email = await parseEmail(input.path, previewController.signal);
      return {
        subject: email.subject,
        sender: email.sender,
        recipients: email.recipients,
        sentAt: email.sentAt,
        html: buildEmailHtml(email),
        attachmentCount: email.attachments.filter((item) => !item.inline && !item.hidden).length,
      };
    } finally {
      previewController = null;
    }
  });
  handle(CHANNELS.revealOutput, z.undefined(), async () => {
    const path = latest?.output ?? output?.path;
    if (!path) throw new Error('Choose an output folder first');
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  handle(CHANNELS.openResult, z.string().uuid(), async (id) => {
    const result = latest?.results.find((item) => item.id === id);
    if (!result || !['converted', 'copied', 'partial'].includes(result.status))
      throw new Error('This file has no completed PDF');
    // Reveal only a main-process-owned result. The renderer never supplies paths.
    shell.showItemInFolder(result.destination);
  });
  handle(CHANNELS.exportReport, z.undefined(), async () => {
    if (!latest) throw new Error('Complete a conversion before exporting a report');
    const selected = await dialog.showSaveDialog(window, {
      title: 'Export conversion report',
      defaultPath: 'conversion-report.json',
      filters: [{ name: 'JSON report', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return false;
    if (extname(selected.filePath).toLowerCase() !== '.json')
      throw new Error('The report filename must end in .json');
    if (latest.results.some((file) => resolve(file.source) === resolve(selected.filePath ?? '')))
      throw new Error('A report cannot replace an input file');
    await atomicWrite(
      selected.filePath,
      dirname(selected.filePath),
      Buffer.from(JSON.stringify(latest, null, 2)),
      true,
    );
    return true;
  });
  handle(CHANNELS.history, z.undefined(), () => store.history());
  handle(CHANNELS.clearHistory, z.undefined(), () => store.clearHistory());
  handle(CHANNELS.chooseOffice, z.undefined(), async () => {
    idle();
    const selected = await dialog.showOpenDialog(window, {
      title: 'Locate LibreOffice',
      message:
        process.platform === 'darwin'
          ? 'Choose LibreOffice.app or the soffice executable.'
          : 'Choose the soffice or soffice.exe executable inside LibreOffice.',
      properties: ['openFile'],
    });
    const path = selected.filePaths[0];
    if (selected.canceled || !path) return getOffice();
    const status = await detectOffice(path);
    if (status.available) await store.setOfficePath(path);
    officePromise = Promise.resolve(status);
    return status;
  });
  handle(CHANNELS.detectOffice, z.undefined(), () => {
    officePromise = null;
    return getOffice();
  });
  handle(CHANNELS.downloadOffice, z.undefined(), () =>
    shell.openExternal(LIBREOFFICE_DOWNLOAD_URL),
  );
  return async () => {
    closing = true;
    current?.abort();
    previewController?.abort();
    for (const channel of handlers) ipcMain.removeHandler(channel);
    await Promise.allSettled([...pending]);
  };
}
