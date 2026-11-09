import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { app, BrowserWindow, Menu, nativeTheme, protocol, session } from 'electron';
import { errorMessage } from '../shared/errors';
import { originKey } from '../shared/security';
import { registerDesktopApi } from './ipc';
import { AppStore } from './store';
import { runCliWorker } from './terminal';

const isTerminal = process.argv.includes('--cli');
const userDataArgument = process.argv.find((value) => value.startsWith('--user-data-dir='));
if (userDataArgument && !app.isPackaged) {
  app.setPath('userData', resolve(userDataArgument.slice('--user-data-dir='.length)));
}
if (isTerminal) {
  app.dock?.hide();
  app.setPath('userData', join(app.getPath('temp'), `msg2pdf-cli-${process.pid}`));
}
app.setName('msg2pdf');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
let mainWindow: BrowserWindow | null = null;
let dispose: (() => Promise<void>) | undefined;
let closingForReal = false;
let cleanlyClosed = false;
function shutdown(): void {
  if (closingForReal) return;
  closingForReal = true;
  const cleanup = dispose;
  dispose = undefined;
  Promise.resolve(cleanup?.())
    .catch((error: unknown) => console.error(errorMessage(error)))
    .finally(() => {
      cleanlyClosed = true;
      mainWindow?.destroy();
      app.quit();
    });
}
const singleInstance = isTerminal || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
async function createWindow(): Promise<void> {
  const rendererRoot = resolve(__dirname, '../renderer');
  const dev = !app.isPackaged && process.env.MSG2PDF_DEV_SERVER_URL;
  const devUrl = dev ? new URL(dev) : null;
  if (devUrl && (devUrl.protocol !== 'http:' || devUrl.hostname !== '127.0.0.1'))
    throw new Error('The development server must use local HTTP');
  const uiUrl = devUrl?.href ?? 'app://ui/index.html';
  const origin = originKey(uiUrl);
  if (!dev) {
    await protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
      if (
        url.hostname !== 'ui' ||
        request.method !== 'GET' ||
        (file !== rendererRoot && !file.startsWith(`${rendererRoot}${sep}`))
      )
        return new Response('Not found', { status: 404 });
      try {
        const data = await readFile(file);
        const extension = file.split('.').at(-1);
        const type =
          (
            {
              html: 'text/html',
              js: 'application/javascript',
              css: 'text/css',
              svg: 'image/svg+xml',
              woff2: 'font/woff2',
              ttf: 'font/ttf',
              png: 'image/png',
            } as Record<string, string>
          )[extension ?? ''] ?? 'application/octet-stream';
        return new Response(data, {
          headers: {
            'Content-Type': type,
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'",
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
  }
  const uiSession = session.defaultSession;
  uiSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  uiSession.setPermissionCheckHandler(() => false);
  uiSession.on('will-download', (event) => event.preventDefault());
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    title: 'msg2pdf',
    width: 1360,
    height: 940,
    minWidth: 980,
    minHeight: 720,
    show: false,
    backgroundColor: '#19171b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const store = new AppStore(app.getPath('userData'));
  const disposeDesktop = registerDesktopApi(mainWindow, store, origin);
  const disposeStudio =
    process.platform === 'linux' && process.arch === 'arm64'
      ? (await import('./studio/service')).registerStudioApi(mainWindow, origin)
      : undefined;
  dispose = async () => {
    await Promise.all([disposeDesktop(), disposeStudio?.()]);
  };
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (originKey(url) !== origin) event.preventDefault();
  });
  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (cleanlyClosed) return;
    event.preventDefault();
    shutdown();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    void dispose?.();
    dispose = undefined;
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
  await mainWindow.loadURL(uiUrl);
}
app
  .whenReady()
  .then(async () => {
    if (!singleInstance) return;
    if (isTerminal) await runCliWorker();
    else await createWindow();
  })
  .catch((error: unknown) => {
    console.error(errorMessage(error));
    app.exit(1);
  });
app.on('activate', () => {
  if (!isTerminal && !mainWindow && !closingForReal)
    createWindow().catch((error: unknown) => console.error(errorMessage(error)));
});
app.on('window-all-closed', () => {
  if (!isTerminal) app.quit();
});
app.on('before-quit', (event) => {
  if (!isTerminal && !cleanlyClosed) {
    event.preventDefault();
    shutdown();
  }
});
