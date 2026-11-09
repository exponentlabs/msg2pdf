import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { BatchSummary, ConversionEvent } from '../shared/contracts';
import { errorMessage } from '../shared/errors';
import { parseArguments, terminalText } from './arguments';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  if (argv[0] === 'studio') {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ASAR;
    const worker = spawn(
      process.env.MSG2PDF_ELECTRON_EXE ?? process.execPath,
      [resolve(__dirname, '../..'), '--cli', ...argv],
      { env, stdio: ['pipe', 'inherit', 'inherit'] },
    );
    const cancel = () => {
      if (!worker.stdin.destroyed) worker.stdin.write('cancel\n');
    };
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    worker.stdin.on('error', () => {});
    return new Promise<number>((resolveExit) => {
      worker.on('error', () => resolveExit(1));
      worker.on('exit', (code) => {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
        resolveExit(code ?? 1);
      });
    });
  }
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`ERROR: ${terminalText(errorMessage(error))}\n`);
    return 2;
  }
  if (typeof parsed === 'number') return parsed;
  const executable = process.env.MSG2PDF_ELECTRON_EXE ?? process.execPath;
  const appRoot = resolve(__dirname, '../..');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  if (env.NO_COLOR !== undefined) delete env.FORCE_COLOR;
  const child = spawn(executable, [appRoot, '--cli', ...argv], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let completed = 0;
  let total = 0;
  let summary: BatchSummary | null = null;
  let lineLength = 0;
  const live = !parsed.json && !parsed.verbose && process.stderr.isTTY;
  const clear = (): void => {
    if (lineLength) {
      process.stderr.write(`\r${' '.repeat(lineLength)}\r`);
      lineLength = 0;
    }
  };
  const progress = (): void => {
    if (!live) return;
    const text = `Converting ${completed} / ${total}`;
    process.stderr.write(`\r${text.padEnd(lineLength)}`);
    lineLength = text.length;
  };
  const cancel = (): void => {
    clear();
    if (!child.stdin.destroyed) child.stdin.write('cancel\n');
  };
  child.stdin.on('error', () => {
    /* The worker may have exited just before a signal. */
  });
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  child.stderr.on('data', (chunk: Buffer) => {
    clear();
    process.stderr.write(`${terminalText(chunk.toString()).trimEnd()}\n`);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const event = JSON.parse(line) as ConversionEvent | { type: 'error'; message: string };
      if (event.type === 'plan') {
        total = event.plan.files.length;
        progress();
      } else if (event.type === 'file-complete') {
        completed++;
        progress();
        if (event.result.error || parsed.verbose) {
          clear();
          process.stderr.write(
            `${event.result.status}: ${terminalText(event.result.relativeName)}${event.result.error ? ` — ${terminalText(event.result.error)}` : ''}\n`,
          );
        }
      } else if (event.type === 'complete') summary = event.summary;
      else if (event.type === 'error') {
        clear();
        process.stderr.write(`ERROR: ${terminalText(event.message)}\n`);
      }
    } catch {
      clear();
      process.stderr.write('ERROR: Invalid conversion-worker response\n');
    }
  });
  const code = await new Promise<number>((resolveExit) => {
    child.on('error', (error) => {
      clear();
      process.stderr.write(`ERROR: ${terminalText(error.message)}\n`);
      resolveExit(1);
    });
    child.on('close', (exitCode) => resolveExit(exitCode ?? 1));
  });
  clear();
  lines.close();
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  const finalSummary = summary as BatchSummary | null;
  if (finalSummary) {
    if (parsed.json) process.stdout.write(`${JSON.stringify(finalSummary)}\n`);
    else {
      for (const issue of finalSummary.issues)
        process.stderr.write(
          `ERROR: ${terminalText(issue.path)} — ${terminalText(issue.message)}\n`,
        );
      process.stdout.write(
        `Processed: ${finalSummary.processed}\nConverted: ${finalSummary.converted}\nCopied:    ${finalSummary.copied}\nSkipped:   ${finalSummary.skipped}\nUnsupported: ${finalSummary.unsupported}\nFailed:    ${finalSummary.failed}\nAttachments: ${finalSummary.attachments}\n${finalSummary.cancelled ? 'Cancelled.\n' : ''}`,
      );
    }
  }
  return code;
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`ERROR: ${terminalText(errorMessage(error))}\n`);
    process.exitCode = 1;
  });
