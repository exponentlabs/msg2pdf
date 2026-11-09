import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { PDFDocument } from 'pdf-lib';

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
app.setPath('userData', process.env.B1_PROFILE);
app
  .whenReady()
  .then(async () => {
    const isolated = session.fromPartition('b1');
    isolated.protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      const file = resolve(__dirname, `.${decodeURIComponent(url.pathname)}`);
      if (
        url.hostname !== 'b1' ||
        request.method !== 'GET' ||
        !file.startsWith(`${__dirname}${sep}`)
      )
        return new Response('Denied', { status: 403 });
      try {
        const mime =
          {
            '.html': 'text/html',
            '.css': 'text/css',
            '.mjs': 'application/javascript',
            '.wasm': 'application/wasm',
          }[extname(file)] ?? 'application/octet-stream';
        return new Response(await readFile(file), {
          headers: {
            'Content-Type': mime,
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
          },
        });
      } catch {
        return new Response('Missing', { status: 404 });
      }
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_request, callback) => callback({ cancel: true }),
    );
    const window = new BrowserWindow({
      show: true,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        session: isolated,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const harness = {
      packaged: app.isPackaged,
      versions: process.versions,
      async assemble(pages) {
        const document = await PDFDocument.create({ updateMetadata: false });
        for (const item of pages) {
          const image = await document.embedPng(Buffer.from(item.png, 'base64'));
          document.addPage([item.width, item.height]).drawImage(image, {
            x: 0,
            y: 0,
            width: item.width,
            height: item.height,
          });
        }
        document.setProducer('msg2pdf raster-v1');
        document.setCreator('msg2pdf');
        return Buffer.from(await document.save({ useObjectStreams: false })).toString('base64');
      },
    };
    ipcMain.handle('b1-runtime', (event) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error('Invalid harness caller');
      return { packaged: app.isPackaged, versions: process.versions };
    });
    ipcMain.handle('b1-assemble', (event, pages) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error('Invalid harness caller');
      if (
        !Array.isArray(pages) ||
        pages.length < 1 ||
        pages.length > 8 ||
        pages.some(
          (item) =>
            typeof item.png !== 'string' ||
            item.png.length > 16 * 1024 * 1024 ||
            !Number.isFinite(item.width) ||
            !Number.isFinite(item.height) ||
            item.width < 1 ||
            item.height < 1 ||
            item.width > 2000 ||
            item.height > 2000,
        )
      )
        throw new Error('Invalid synthetic pages');
      return harness.assemble(pages);
    });
    await window.loadURL('app://b1/viewer.html');
    app.on('window-all-closed', () => app.quit());
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
