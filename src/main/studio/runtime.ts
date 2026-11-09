import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow, session } from 'electron';
import { z } from 'zod';
import { pageSchema, type ReviewPage } from '../../core/studio/domain';
import { inversePoint } from '../../core/studio/geometry';
import type { Snapshot, SnapshotPage } from '../../shared/studio';
import { bytesHash } from './store';

const execute = promisify(execFile);
const recordSchema = z.record(z.string(), z.unknown());
const matrixSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const snapshotPageSchema: z.ZodType<SnapshotPage> = z
  .object({
    width: z.number().positive().max(2000),
    height: z.number().positive().max(2000),
    transform: matrixSchema,
    info: pageSchema,
    png: z.string().max(24 * 1024 * 1024),
    referenceRgb: z.string().max(16 * 1024 * 1024),
    text: z
      .array(
        z
          .object({
            text: z.string().max(10_000),
            rect: z.tuple([
              z.number().finite(),
              z.number().finite(),
              z.number().finite(),
              z.number().finite(),
            ]),
          })
          .strict(),
      )
      .max(50_000),
  })
  .strict();
export const snapshotSchema: z.ZodType<Snapshot> = z
  .object({
    pages: z.array(snapshotPageSchema).min(1).max(8),
    revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
    engine: z.string().min(1),
  })
  .strict();
export interface RuntimeStatus {
  available: boolean;
  reason?: string;
  contractHash: string;
  engine: string;
  checkers: string[];
}

export class StudioRuntime {
  private renderSession: Electron.Session | undefined;
  readonly assets = join(app.getAppPath(), 'out/studio');
  async status(): Promise<RuntimeStatus> {
    try {
      if (
        process.platform !== 'linux' ||
        process.arch !== 'arm64' ||
        !/VERSION_ID=44\b/.test(await readFile('/etc/os-release', 'utf8')) ||
        process.versions.electron !== '45.2.3'
      )
        throw new Error('The studio is qualified for Fedora 44 ARM64 with this app runtime.');
      const contractHash = bytesHash(await readFile(join(this.assets, 'evaluation-contract.json')));
      const tools: Record<string, string> = {};
      for (const tool of [
        'qpdf',
        'pdftoppm',
        'pdfinfo',
        'pdftotext',
        'pdfdetach',
        'bwrap',
        'prlimit',
      ]) {
        const path = await realpath(`/usr/bin/${tool}`);
        const info = await lstat(path);
        if (!info.isFile() || info.uid !== 0 || info.mode & 0o022)
          throw new Error('Verifier tools must be system-managed.');
        tools[tool] = bytesHash(await readFile(path));
      }
      const qpdf = await execute('/usr/bin/qpdf', ['--version'], { timeout: 5000 });
      const poppler = await execute('/usr/bin/pdftoppm', ['-v'], { timeout: 5000 });
      if (
        !/^qpdf version 12\.3\.2\b/.test(qpdf.stdout) ||
        !/^pdftoppm version 26\.01\.0\b/.test(poppler.stderr)
      )
        throw new Error('Installed verifier versions need qualification.');
      const packages = await execute(
        '/usr/bin/rpm',
        ['-q', 'qpdf', 'qpdf-libs', 'poppler', 'poppler-utils'],
        { timeout: 5000 },
      );
      if (
        packages.stdout.trim() !==
        'qpdf-12.3.2-1.fc44.aarch64\nqpdf-libs-12.3.2-1.fc44.aarch64\npoppler-26.01.0-3.fc44.aarch64\npoppler-utils-26.01.0-3.fc44.aarch64'
      )
        throw new Error('Verifier package updates need qualification.');
      const libraries: Record<string, string> = {};
      for (const binary of ['/usr/bin/qpdf', '/usr/bin/pdftoppm']) {
        const dependencies = await execute('/usr/bin/ldd', [binary], { timeout: 5000 });
        if (dependencies.stdout.includes('not found'))
          throw new Error('Verifier libraries are missing.');
        for (const match of dependencies.stdout.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)) {
          const value = match[1];
          if (!value) continue;
          const path = await realpath(value);
          if (!(path in libraries)) libraries[path] = bytesHash(await readFile(path));
        }
      }
      const engine = createHash('sha256');
      for (const file of [
        'engine.mjs',
        'pdf.mjs',
        'pdf.worker.mjs',
        'assemble.cjs',
        'raster-policy.cjs',
        'verify.cjs',
      ])
        engine.update(await readFile(join(this.assets, file)));
      return {
        available: true,
        contractHash,
        engine: `raster-v1:${engine.digest('hex')}`,
        checkers: [
          `qpdf:${bytesHash(Buffer.from(JSON.stringify({ tool: tools.qpdf, libraries, packages: packages.stdout })))}`,
          `poppler:${bytesHash(Buffer.from(JSON.stringify({ tools, libraries, packages: packages.stdout })))}`,
        ],
      };
    } catch (error) {
      return {
        available: false,
        reason:
          error instanceof Error ? error.message : 'Install the studio verifier prerequisites.',
        contractHash: '',
        engine: '',
        checkers: [],
      };
    }
  }
  async worker(
    workspace: string,
    script: 'verify.cjs' | 'assemble.cjs',
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const executableRoot = dirname(process.execPath);
    const flags = [
      '--unshare-all',
      '--die-with-parent',
      '--clearenv',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--setenv',
      'HOME',
      '/tmp',
      '--setenv',
      'ELECTRON_RUN_AS_NODE',
      '1',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--ro-bind',
      '/etc/fonts',
      '/etc/fonts',
      '--ro-bind',
      executableRoot,
      '/app',
      '--bind',
      workspace,
      '/work',
      '--chdir',
      '/work',
    ];
    if (!app.isPackaged) flags.push('--ro-bind', this.assets, '/runtime');
    for (const name of ['input.pdf', 'request.json', 'output.pdf']) {
      try {
        await lstat(join(workspace, name));
        flags.push('--ro-bind', join(workspace, name), `/work/${name}`);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    const entry = app.isPackaged
      ? `/app/resources/app.asar/out/studio/${script}`
      : `/runtime/${script}`;
    return new Promise((resolveRun, reject) => {
      const child = spawn(
        '/usr/bin/bwrap',
        [
          ...flags,
          `/app/${basename(process.execPath)}`,
          '--max-old-space-size=256',
          entry,
          ...args,
        ],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let settled = false;
      let pendingError: Error | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        if (error && child.pid && child.exitCode === null && child.signalCode === null) {
          if (!pendingError) {
            pendingError = error;
            child.kill('SIGKILL');
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearInterval(memory);
        signal?.removeEventListener('abort', abort);
        if (pendingError || error) {
          reject(pendingError ?? error);
        } else resolveRun(stdout);
      };
      const abort = () => finish(new Error('CANCELLED'));
      const timer = setTimeout(() => finish(new Error('WORKER_TIMEOUT')), 30_000);
      const memory = setInterval(() => {
        const inspect = async (pid: number, depth = 0): Promise<number> => {
          if (depth > 5) throw new Error('WORKER_PROCESS_LIMIT');
          const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
          let rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
          const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(
            () => '',
          );
          const ids = children.trim().split(/\s+/).filter(Boolean);
          if (ids.length > 16) throw new Error('WORKER_PROCESS_LIMIT');
          for (const id of ids) rss += await inspect(Number(id), depth + 1);
          return rss;
        };
        if (child.pid)
          void inspect(child.pid)
            .then((rss) => {
              if (rss > 512 * 1024) finish(new Error('WORKER_MEMORY_LIMIT'));
            })
            .catch(() => finish(new Error('WORKER_MEMORY_LIMIT')));
      }, 200);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new Error('WORKER_UNAVAILABLE')));
      child.stdout.on('data', (chunk: Buffer) => {
        if (pendingError) return;
        stdout += chunk.toString();
        if (stdout.length > 24 * 1024 * 1024) finish(new Error('WORKER_OUTPUT_LIMIT'));
      });
      child.stderr.resume();
      child.on('close', (code) =>
        code === 0 ? finish() : finish(new Error('VERIFICATION_FAILED')),
      );
      if (signal?.aborted) abort();
    });
  }
  async checker(
    workspace: string,
    operation: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result: unknown = JSON.parse(
      await this.worker(workspace, 'verify.cjs', [operation, ...args], signal),
    );
    return z.object({ stdout: z.string(), stderr: z.string() }).strict().parse(result).stdout;
  }
  metadata(graph: unknown): ReviewPage[] {
    const root = recordSchema.parse(graph);
    const encryption = recordSchema.parse(root.encrypt);
    if (encryption.encrypted !== false) throw new Error('PASSWORD_PROTECTED');
    const tables = z.array(z.unknown()).length(2).parse(root.qpdf);
    const objects = recordSchema.parse(tables[1]);
    const value = (ref: string): Record<string, unknown> =>
      recordSchema.parse(recordSchema.parse(objects[`obj:${ref}`]).value);
    const inherited = (page: Record<string, unknown>, key: string): unknown => {
      let current = page;
      const seen = new Set<string>();
      for (let depth = 0; depth < 32; depth++) {
        if (key in current) return current[key];
        const parent = current['/Parent'];
        if (typeof parent !== 'string') return undefined;
        if (seen.has(parent)) throw new Error('PAGE_TREE_CYCLE');
        seen.add(parent);
        current = value(parent);
      }
      throw new Error('PAGE_TREE_LIMIT');
    };
    return z
      .array(z.object({ object: z.string() }).passthrough())
      .min(1)
      .max(8)
      .parse(root.pages)
      .map((entry) => {
        const page = value(entry.object);
        const mediaBox = pageSchema.shape.mediaBox.parse(inherited(page, '/MediaBox'));
        const crop = pageSchema.shape.cropBox.parse(inherited(page, '/CropBox') ?? mediaBox);
        return pageSchema.parse({
          mediaBox,
          cropBox: [
            Math.max(mediaBox[0], crop[0]),
            Math.max(mediaBox[1], crop[1]),
            Math.min(mediaBox[2], crop[2]),
            Math.min(mediaBox[3], crop[3]),
          ],
          rotation: ((Number(inherited(page, '/Rotate') ?? 0) % 360) + 360) % 360,
          userUnit: Number(page['/UserUnit'] ?? 1),
        });
      });
  }
  async render(
    bytes: Buffer,
    pageInfos: ReviewPage[],
    engine: string,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    signal?.throwIfAborted();
    this.renderSession ??= session.fromPartition('studio-engine', { cache: false });
    const isolated = this.renderSession;
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'file://*/*', 'ws://*/*', 'wss://*/*'] },
      (_request, callback) => callback({ cancel: true }),
    );
    isolated.protocol.handle('app', async (request) => {
      try {
        const url = new URL(request.url);
        const path = resolve(this.assets, `.${decodeURIComponent(url.pathname)}`);
        const child = relative(this.assets, path).split(sep).join('/');
        if (
          url.hostname !== 'studio-engine' ||
          request.method !== 'GET' ||
          !/^(engine\.(mjs|html)|pdf(\.worker)?\.mjs|(standard_fonts|cmaps|wasm)\/[a-zA-Z0-9_.-]+)$/.test(
            child,
          )
        )
          return new Response('Denied', { status: 403 });
        const mime =
          { '.html': 'text/html', '.mjs': 'application/javascript', '.wasm': 'application/wasm' }[
            extname(path)
          ] ?? 'application/octet-stream';
        return new Response(await readFile(path), {
          headers: {
            'Content-Type': mime,
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
          },
        });
      } catch {
        return new Response('Missing', { status: 404 });
      }
    });
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        session: isolated,
        devTools: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const abort = () => {
      if (!window.isDestroyed()) window.destroy();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    const memory = setInterval(() => {
      if (window.isDestroyed()) return;
      const pid = window.webContents.getOSProcessId();
      const metric = app.getAppMetrics().find((item) => item.pid === pid);
      if (metric && metric.memory.workingSetSize > 512 * 1024) abort();
    }, 200);
    try {
      await window.loadURL('app://studio-engine/engine.html');
      const input = JSON.stringify({ bytes: bytes.toString('base64'), pageInfos });
      const value: unknown = await window.webContents.executeJavaScript(
        `globalThis.prepareStudioSnapshot(${input})`,
      );
      const parsed = z
        .object({ pages: z.array(snapshotPageSchema).min(1).max(8) })
        .strict()
        .parse(value);
      for (const page of parsed.pages) inversePoint(page.transform, 0, 0);
      signal?.throwIfAborted();
      return { ...parsed, revisionHash: bytesHash(bytes), engine };
    } catch {
      throw new Error(signal?.aborted ? 'CANCELLED' : 'PDF_PREPARATION_FAILED');
    } finally {
      clearTimeout(timer);
      clearInterval(memory);
      signal?.removeEventListener('abort', abort);
      if (!window.isDestroyed()) window.destroy();
      await isolated.clearStorageData();
      isolated.protocol.unhandle('app');
    }
  }
}
