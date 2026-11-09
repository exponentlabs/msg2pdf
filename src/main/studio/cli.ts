import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { z } from 'zod';
import { StudioService } from './service';
import { CaseStore, nativeCaseLock } from './store';

/** Automation consumes GUI-recorded reviews/approval; it cannot create either. */
export async function runStudioCli(args: string[], signal: AbortSignal): Promise<unknown> {
  const [command, root, ...rest] = args;
  if (
    !root ||
    !['status', 'capture', 'prepare', 'apply', 'publish', 'backup'].includes(command ?? '')
  )
    throw new Error(
      'Usage: studio status CASE | capture CASE INPUT VERSION | prepare CASE ID VERSION | apply CASE ID VERSION | publish CASE VERSION | backup CASE EMPTY_FOLDER',
    );
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  const service = new StudioService(window);
  const abort = () => service.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    service.store = await CaseStore.open(
      root,
      nativeCaseLock(
        app.isPackaged
          ? join(process.resourcesPath, 'native/studio-lock.node')
          : join(app.getAppPath(), 'resources/native/studio-lock.node'),
      ),
    );
    signal.throwIfAborted();
    const version = (value: string | undefined) =>
      z.coerce.number().int().nonnegative().parse(value);
    await service.run(async (taskSignal) => {
      if (command === 'status' && !rest.length) return;
      if (command === 'capture' && rest.length === 2 && rest[0])
        await service.store?.capture(rest[0], version(rest[1]), taskSignal);
      else if (command === 'prepare' && rest.length === 2)
        await service.prepare({ id: rest[0], version: version(rest[1]) }, taskSignal);
      else if (command === 'apply' && rest.length === 2)
        await service.apply({ id: rest[0], version: version(rest[1]) }, taskSignal);
      else if (command === 'publish' && rest.length === 1)
        await service.publish({ version: version(rest[0]) }, taskSignal);
      else if (command === 'backup' && rest.length === 1 && rest[0])
        await service.store?.backup(rest[0]);
      else throw new Error('INVALID_STUDIO_ARGUMENTS');
    });
    const view = await service.view();
    return {
      type: 'studio-result',
      profile: view.profile,
      available: view.available,
      caseId: view.case?.state.id,
      version: view.case?.state.version,
      documents: view.case?.state.documents.map((document) => ({
        id: document.id,
        stage: document.revision ? 'For Redaction' : 'Exported',
        blockers: view.case?.blockers[document.id],
      })),
      releases:
        view.case?.state.releases?.map((release) => ({
          id: release.approval.manifest.releaseId,
          manifestHash: release.approval.manifestHash,
        })) ?? [],
    };
  } finally {
    signal.removeEventListener('abort', abort);
    await service.dispose();
    window.destroy();
  }
}
