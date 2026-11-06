import { parseEmailFile } from '../core/email';
import { errorMessage } from '../shared/errors';

process.parentPort?.on('message', (event: Electron.MessageEvent) => {
  const payload: unknown = event.data;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('path' in payload) ||
    typeof payload.path !== 'string'
  ) {
    process.parentPort?.postMessage({ error: 'Invalid parser request' });
    return;
  }
  parseEmailFile(payload.path)
    .then((message) => process.parentPort?.postMessage({ message }))
    .catch((error: unknown) => process.parentPort?.postMessage({ error: errorMessage(error) }));
});
