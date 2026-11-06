import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS } from '../shared/channels';
import type { ConversionEvent, DesktopApi } from '../shared/contracts';

function invoke<T>(channel: string, value?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, value) as Promise<T>;
}
const api: DesktopApi = {
  info: () => invoke(CHANNELS.info),
  chooseInputs: (kind) => invoke(CHANNELS.chooseInputs, kind),
  importDroppedFiles: (files) =>
    invoke(
      CHANNELS.importPaths,
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ),
  chooseOutput: () => invoke(CHANNELS.chooseOutput),
  plan: (request) => invoke(CHANNELS.plan, request),
  convert: (request) => invoke(CHANNELS.convert, request),
  cancel: () => invoke(CHANNELS.cancel),
  preview: (id) => invoke(CHANNELS.preview, id),
  revealOutput: () => invoke(CHANNELS.revealOutput),
  openResult: (id) => invoke(CHANNELS.openResult, id),
  exportReport: () => invoke(CHANNELS.exportReport),
  history: () => invoke(CHANNELS.history),
  clearHistory: () => invoke(CHANNELS.clearHistory),
  chooseOffice: () => invoke(CHANNELS.chooseOffice),
  detectOffice: () => invoke(CHANNELS.detectOffice),
  downloadOffice: () => invoke(CHANNELS.downloadOffice),
  onProgress: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, event: ConversionEvent): void =>
      listener(event);
    ipcRenderer.on(CHANNELS.progress, receive);
    return () => ipcRenderer.removeListener(CHANNELS.progress, receive);
  },
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(api));
