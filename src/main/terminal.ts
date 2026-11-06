import { dirname, resolve } from 'node:path';
import { app } from 'electron';
import { runConversion } from '../core/engine';
import { atomicWrite } from '../core/filesystem';
import { detectOffice } from '../core/office';
import { createPlan } from '../core/planner';
import { errorMessage } from '../shared/errors';
import { parseArguments } from '../terminal/arguments';
import { createServices } from './services';
import { AppStore } from './store';

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
export async function runCliWorker(): Promise<void> {
  const offset = process.argv.indexOf('--cli');
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (value: string) => {
    if (value.includes('cancel')) abort();
  });
  let code = 2;
  try {
    const args = parseArguments(process.argv.slice(offset + 1), app.getVersion());
    if (typeof args === 'number') {
      app.exit(args);
      return;
    }
    const plan = await createPlan(args.request, controller.signal);
    code = 1;
    if (
      args.report &&
      plan.files.some((file) => resolve(file.source) === resolve(args.report ?? ''))
    )
      throw new Error('A report cannot replace an input file');
    const store = new AppStore(resolve(app.getPath('appData'), 'msg2pdf'));
    let office = args.office;
    if (!office) office = await store.officePath();
    const officeStatus = detectOffice(office);
    const services = createServices(() => officeStatus);
    const summary = await runConversion(
      plan,
      services,
      (event) => {
        if (event.type !== 'complete') emit(event);
      },
      controller.signal,
    );
    if (args.report)
      await atomicWrite(
        args.report,
        dirname(args.report),
        Buffer.from(JSON.stringify(summary, null, 2)),
        args.request.options.overwrite,
      );
    emit({ type: 'complete', summary });
    code = summary.cancelled ? 130 : summary.failed ? 1 : 0;
  } catch (error) {
    if (controller.signal.aborted) code = 130;
    emit({ type: 'error', message: errorMessage(error) });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.stdin.pause();
    await new Promise<void>((resolveFlush) => process.stdout.write('', () => resolveFlush()));
    app.exit(code);
  }
}
