// Vector source is checked in; regenerate the raster only when the icon changes.
const { app, BrowserWindow } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 1024,
      height: 1024,
      useContentSize: true,
      transparent: true,
      webPreferences: { sandbox: true, nodeIntegration: false, javascript: false },
    });
    const svg = await readFile('build/icon.svg', 'utf8');
    await window.loadURL(
      `data:text/html,${encodeURIComponent(`<style>body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${svg}`)}`,
    );
    await writeFile('build/icon.png', (await window.webContents.capturePage()).toPNG());
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
