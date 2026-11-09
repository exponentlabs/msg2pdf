import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS } from '../shared/channels';
import type { ConversionEvent, DesktopApi } from '../shared/contracts';
import type { StudioApi } from '../shared/studio';

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
const studio: StudioApi = {
  status: () => invoke('studio:status'),
  create: () => invoke('studio:create'),
  open: () => invoke('studio:open'),
  close: () => invoke('studio:close'),
  backup: () => invoke('studio:backup'),
  import: () => invoke('studio:import'),
  prepare: (request) => invoke('studio:prepare', request),
  snapshot: (request) => invoke('studio:snapshot', request),
  saveMarks: (request) => invoke('studio:saveMarks', request),
  reviewPage: (request) => invoke('studio:reviewPage', request),
  search: (request) => invoke('studio:search', request),
  cancel: () => invoke('studio:cancel'),
  apply: (request) => invoke('studio:apply', request),
  reviewCandidate: (request) => invoke('studio:reviewCandidate', request),
  approveRelease: (request) => invoke('studio:approveRelease', request),
  publish: (request) => invoke('studio:publish', request),
};
contextBridge.exposeInMainWorld('studio', Object.freeze(studio));
