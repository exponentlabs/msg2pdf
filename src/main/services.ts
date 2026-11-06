import { join } from 'node:path';
import { app, BrowserWindow, session, utilityProcess } from 'electron';
import type { NormalizedEmail } from '../core/email';
import type { ConversionServices } from '../core/engine';
import { LIMITS } from '../core/limits';
import { createOfficeConverter } from '../core/office';
import type { OfficeStatus } from '../shared/contracts';
import { CancelledError, errorMessage, throwIfCancelled } from '../shared/errors';

let pdfSession: Electron.Session | undefined;
function getPdfSession(): Electron.Session {
  if (pdfSession) return pdfSession;
  const isolated = session.fromPartition('msg2pdf-render', { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest({ urls: ['*://*/*', 'file://*/*'] }, (_details, callback) =>
    callback({ cancel: true }),
  );
  pdfSession = isolated;
  return isolated;
}

export function createServices(getOffice: () => Promise<OfficeStatus>): ConversionServices {
  return {
    parseEmail,
    renderPdf,
    convertOffice: createOfficeConverter(
      getOffice,
      app.isPackaged
        ? join(process.resourcesPath, 'native', 'office-sandbox.exe')
        : join(app.getAppPath(), 'resources', 'native', 'office-sandbox.exe'),
    ),
  };
}
export async function parseEmail(path: string, signal?: AbortSignal): Promise<NormalizedEmail> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const worker = utilityProcess.fork(join(__dirname, 'parser-worker.cjs'), [], {
      execArgv: [`--max-old-space-size=${LIMITS.workerMemoryMb}`],
      serviceName: 'Email parser',
      stdio: 'pipe',
    });
    let settled = false;
    let diagnostic = '';
    const finish = (message?: NormalizedEmail, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(memory);
      signal?.removeEventListener('abort', abort);
      worker.kill();
      if (error) reject(error);
      else if (message) resolve(message);
      else reject(new Error('Parser returned no message'));
    };
    const abort = (): void => finish(undefined, new CancelledError());
    const timeout = setTimeout(
      () => finish(undefined, new Error('Email parsing timed out after 30 seconds')),
      LIMITS.parseTimeoutMs,
    );
    const memory = setInterval(() => {
      const metric = app.getAppMetrics().find((item) => item.pid === worker.pid);
      if (metric && metric.memory.workingSetSize > LIMITS.workerMemoryMb * 1024)
        finish(undefined, new Error('Email parser exceeded its memory budget'));
    }, 200);
    signal?.addEventListener('abort', abort, { once: true });
    worker.stderr?.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-2000);
    });
    worker.on('spawn', () => worker.postMessage({ path }));
    worker.on('message', (response: { message?: NormalizedEmail; error?: string }) => {
      if (response.error) finish(undefined, new Error(response.error));
      else finish(response.message);
    });
    worker.on('exit', (code) => {
      if (!settled) finish(undefined, new Error(`Email parser stopped (${code}): ${diagnostic}`));
    });
  });
}
export async function renderPdf(
  html: string,
  pageSize: 'A4' | 'Letter',
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfCancelled(signal);
  if (Buffer.byteLength(html) > 32 * 1024 * 1024)
    throw new Error('Render input exceeds the 32 MiB limit');
  const isolatedSession = getPdfSession();
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1100,
    webPreferences: {
      session: isolatedSession,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: false,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: false,
      spellcheck: false,
      plugins: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  let rejectLimit: ((reason: Error) => void) | undefined;
  const exceeded = new Promise<never>((_resolve, reject) => {
    rejectLimit = reject;
  });
  const fail = (error: Error): void => {
    rejectLimit?.(error);
    if (!window.isDestroyed()) window.destroy();
  };
  const abort = (): void => fail(new CancelledError());
  const timeout = setTimeout(
    () => fail(new Error('PDF rendering timed out after 60 seconds')),
    LIMITS.renderTimeoutMs,
  );
  const memory = setInterval(() => {
    if (window.isDestroyed()) return;
    const pid = window.webContents.getOSProcessId();
    const metric = app.getAppMetrics().find((item) => item.pid === pid);
    if (metric && metric.memory.workingSetSize > LIMITS.workerMemoryMb * 1024)
      fail(new Error('PDF renderer exceeded its memory budget'));
  }, 200);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([
      exceeded,
      (async () => {
        await window.loadURL(
          `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`,
        );
        throwIfCancelled(signal);
        const pdf = await window.webContents.printToPDF({
          pageSize,
          printBackground: true,
          preferCSSPageSize: true,
          generateTaggedPDF: true,
        });
        if (pdf.byteLength > LIMITS.pdfBytes)
          throw new Error('Generated PDF exceeds the 256 MiB limit');
        return pdf;
      })(),
    ]);
  } catch (error) {
    if (signal?.aborted) throw new CancelledError();
    throw new Error(errorMessage(error));
  } finally {
    clearTimeout(timeout);
    clearInterval(memory);
    signal?.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
    await isolatedSession.clearStorageData();
  }
}
