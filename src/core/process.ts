import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CancelledError, throwIfCancelled } from '../shared/errors';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}
export interface ProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  memoryBytes?: number;
}
export async function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  throwIfCancelled(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let monitoring = false;
    function terminate(error: Error): void {
      if (settled) return;
      settled = true;
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn(
            join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/F', '/T', '/PID', String(child.pid)],
            { windowsHide: true, stdio: 'ignore' },
          );
          killer.on('error', () => child.kill());
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
      cleanup();
      // Wait for the process to release files before temporary workspaces are
      // removed (especially important on Windows).
      if (child.exitCode !== null || child.signalCode !== null) reject(error);
      else {
        child.once('close', () => reject(error));
        setTimeout(() => reject(error), 3_000).unref();
      }
    }
    const abort = (): void => terminate(new CancelledError());
    const timeout = setTimeout(
      () =>
        terminate(
          new Error(`Conversion timed out after ${Math.round(options.timeoutMs / 1000)} seconds`),
        ),
      options.timeoutMs,
    );
    const memory = setInterval(() => {
      if (!options.memoryBytes || !child.pid || monitoring || process.platform === 'win32') return;
      monitoring = true;
      const sample = spawn('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      const sampleTimeout = setTimeout(() => sample.kill('SIGKILL'), 1_000);
      sample.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 4 * 1024 * 1024) sample.kill();
      });
      sample.on('error', () => {
        clearTimeout(sampleTimeout);
        monitoring = false;
        terminate(new Error('Cannot enforce Office worker memory monitoring'));
      });
      sample.on('close', (code) => {
        clearTimeout(sampleTimeout);
        monitoring = false;
        if (settled) return;
        if (code !== 0) {
          terminate(new Error('Cannot enforce Office worker memory monitoring'));
          return;
        }
        const entries = output
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/).map(Number));
        const descendants = new Set([child.pid]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const [pid, parent] of entries)
            if (pid && parent && descendants.has(parent) && !descendants.has(pid)) {
              descendants.add(pid);
              changed = true;
            }
        }
        const bytes = entries.reduce(
          (total, [pid, , rss]) => total + (pid && rss && descendants.has(pid) ? rss * 1024 : 0),
          0,
        );
        if (bytes > (options.memoryBytes ?? Number.POSITIVE_INFINITY))
          terminate(new Error('Office conversion exceeded its memory budget'));
      });
    }, 500);
    function cleanup(): void {
      clearTimeout(timeout);
      clearInterval(memory);
      options.signal?.removeEventListener('abort', abort);
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024)
        terminate(new Error('Worker diagnostics exceed their size limit'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024)
        terminate(new Error('Worker diagnostics exceed their size limit'));
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0)
        reject(
          new Error(
            `Worker failed (${code ?? 'signal'}): ${(stderr || stdout).trim().slice(-2000)}`,
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}
