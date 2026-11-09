import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OfficeStatus } from '../shared/contracts';
import { errorMessage } from '../shared/errors';
import { atomicProduce, isMissing, shouldWrite } from './filesystem';
import { LIMITS } from './limits';
import { runProcess } from './process';

export const LIBREOFFICE_DOWNLOAD_URL =
  'https://www.libreoffice.org/download/download-libreoffice/';
export function supportedOfficeVersion(output: string): string {
  const match = /LibreOffice\s+(\d+)\.(\d+)\.(\d+)(?:\.\d+)?/i.exec(output);
  if (!match || /alpha|beta|\brc\d|LibreOfficeDev/i.test(output))
    throw new Error('Choose an official stable LibreOffice installation');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !(
      major > 26 ||
      (major === 26 && (minor > 8 || (minor === 8 && patch >= 1) || (minor === 2 && patch >= 6)))
    )
  )
    throw new Error('LibreOffice 26.2.6+ (26.2 branch), or 26.8.1+ is required for security fixes');
  return `${major}.${minor}.${patch}`;
}
async function resolveExecutable(path: string): Promise<string> {
  const candidate = resolve(path);
  const executable = candidate.toLowerCase().endsWith('.app')
    ? join(candidate, 'Contents', 'MacOS', 'soffice')
    : candidate;
  await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  if (!(await lstat(executable)).isFile() && !(await lstat(executable)).isSymbolicLink())
    throw new Error('Select the LibreOffice executable or application');
  return executable;
}
export async function detectOffice(configured?: string): Promise<OfficeStatus> {
  const roots =
    process.platform === 'darwin'
      ? [
          '/Applications/LibreOffice.app/Contents/MacOS/soffice',
          join(homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
        ]
      : process.platform === 'win32'
        ? [
            join(
              process.env.ProgramFiles ?? 'C:\\Program Files',
              'LibreOffice',
              'program',
              'soffice.exe',
            ),
            join(
              process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
              'LibreOffice',
              'program',
              'soffice.exe',
            ),
          ]
        : [
            '/usr/bin/libreoffice',
            '/usr/bin/soffice',
            '/opt/libreoffice26.8/program/soffice',
            '/opt/libreoffice26.2/program/soffice',
          ];
  const configuredPath = configured || process.env.MSG2PDF_SOFFICE;
  let lastError: string | null = null;
  for (const path of configuredPath ? [configuredPath] : roots) {
    try {
      const executable = await resolveExecutable(path);
      const result = await runProcess(executable, ['--version'], { timeoutMs: 10_000 });
      const version = supportedOfficeVersion(result.stdout);
      return {
        available: true,
        executable,
        version,
        source: configuredPath ? 'configured' : 'detected',
        error: null,
      };
    } catch (error) {
      lastError = configuredPath ? errorMessage(error) : lastError;
    }
  }
  return {
    available: false,
    executable: configuredPath ?? null,
    version: null,
    source: 'missing',
    error: lastError,
  };
}
function sandboxQuote(value: string): string {
  return JSON.stringify(value);
}
export async function officeSandbox(
  executable: string,
  args: string[],
  workspacePath: string,
  windowsHelper: string,
): Promise<{ executable: string; args: string[] }> {
  const workspace = await realpath(workspacePath);
  if (process.platform === 'darwin') {
    await access('/usr/bin/sandbox-exec', constants.X_OK);
    let installation = dirname(await realpath(executable));
    if (installation.includes('.app/')) installation = `${installation.split('.app/')[0]}.app`;
    const reads = [
      '/System',
      '/usr',
      '/bin',
      '/sbin',
      '/opt/homebrew',
      '/Library/Fonts',
      join(homedir(), 'Library/Fonts'),
      installation,
      workspace,
    ];
    // dyld opens the root directory during process startup. The literal rule
    // permits that directory only; it does not grant access to its children.
    const profile = `(version 1)(deny default)(allow process-exec process-fork signal sysctl-read mach-lookup ipc-posix*)(allow file-read-metadata)(allow file-read* ${reads.map((path) => `(subpath ${sandboxQuote(path)})`).join(' ')} (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))(allow file-write* (subpath ${sandboxQuote(workspace)}) (literal "/dev/null"))`;
    const ipc = `(allow system-socket (socket-domain AF_UNIX))(allow network-bind network-inbound (local unix-socket (subpath ${sandboxQuote(workspace)})))(allow network-outbound (remote unix-socket (subpath ${sandboxQuote(workspace)})))`;
    return {
      executable: '/usr/bin/sandbox-exec',
      args: ['-p', profile + ipc, executable, ...args],
    };
  }
  if (process.platform === 'linux') {
    let bwrap: string | undefined;
    for (const path of ['/usr/bin/bwrap', '/bin/bwrap']) {
      try {
        await access(path, constants.X_OK);
        bwrap = path;
        break;
      } catch {
        /* Try the next standard location. */
      }
    }
    if (!bwrap) throw new Error('Install bubblewrap (bwrap) to isolate LibreOffice, then retry');
    const command = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL'];
    for (const path of [
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/opt',
      '/etc/fonts',
      '/etc/ld.so.cache',
    ]) {
      try {
        await access(path);
        command.push('--ro-bind', path, path);
      } catch {
        /* Optional platform library root. */
      }
    }
    let installation = dirname(await realpath(executable));
    if (basename(installation) === 'program') installation = dirname(installation);
    if (!installation.startsWith('/usr/') && !installation.startsWith('/opt/'))
      command.push('--ro-bind', installation, installation);
    command.push(
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      workspace,
      workspace,
      '--chdir',
      workspace,
      executable,
      ...args,
    );
    return { executable: bwrap, args: command };
  }
  await access(windowsHelper, constants.X_OK).catch(() => {
    throw new Error(
      'The Windows Office sandbox is missing. Reinstall the packaged app; Office conversion will not run without isolation.',
    );
  });
  return { executable: windowsHelper, args: [workspace, executable, ...args] };
}
export function createOfficeConverter(
  getOffice: () => Promise<OfficeStatus>,
  windowsHelper: string,
) {
  return async (
    source: string,
    destination: string,
    root: string,
    overwrite: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (!(await shouldWrite(destination, root, overwrite))) return false;
    const office = await getOffice();
    if (!office.available || !office.executable)
      throw new Error(
        office.error ||
          'LibreOffice is not configured. Open Settings to locate it or download its installer.',
      );
    // macOS Unix socket paths have a 104-byte limit. Keep the private Office
    // workspace short enough for LibreOffice's instance IPC socket filename.
    const workspace = await mkdtemp(
      process.platform === 'darwin' ? '/private/tmp/m2p-' : join(tmpdir(), 'msg2pdf-office-'),
    );
    try {
      const pdf = await prepareOfficePdf(source, workspace, office, windowsHelper, signal);
      return atomicProduce(destination, root, overwrite, (temporary) =>
        writeFile(temporary, pdf, { mode: 0o600, flag: 'wx' }),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
}

/** Render into a caller-owned private workspace; publication remains the caller's responsibility. */
export async function prepareOfficePdf(
  source: string,
  workspace: string,
  office: OfficeStatus,
  windowsHelper: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!office.available || !office.executable) throw new Error('OFFICE_UNAVAILABLE');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > LIMITS.inputBytes)
    throw new Error('Office input must be a regular file no larger than 100 MiB');
  const input = join(workspace, `document${extname(source).toLowerCase()}`);
  await copyFile(source, input);
  const output = join(workspace, 'pdf');
  const profile = join(workspace, 'profile');
  await mkdir(output);
  await mkdir(join(profile, 'user'), { recursive: true });
  await writeFile(
    join(profile, 'user', 'registrymodifications.xcu'),
    `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`,
    { mode: 0o600 },
  );
  const args = [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    `-env:OSL_SOCKET_PATH=${workspace}`,
    '--headless',
    '--nologo',
    '--nodefault',
    '--norestore',
    '--convert-to',
    'pdf',
    '--outdir',
    output,
    input,
  ];
  const command = await officeSandbox(office.executable, args, workspace, windowsHelper);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    LANG: process.env.LANG || 'en_US.UTF-8',
    HOME: workspace,
    TMPDIR: workspace,
    TEMP: workspace,
    TMP: workspace,
    XDG_CACHE_HOME: join(workspace, 'cache'),
    SAL_USE_VCLPLUGIN: 'svp',
    OSL_SOCKET_PATH: workspace,
  };
  await runProcess(command.executable, command.args, {
    timeoutMs: LIMITS.officeTimeoutMs,
    env,
    cwd: workspace,
    ...(signal ? { signal } : {}),
    memoryBytes: 1536 * 1024 * 1024,
  });
  const converted = join(output, 'document.pdf');
  const info = await lstat(converted).catch((error: unknown) => {
    if (isMissing(error))
      throw new Error(
        'LibreOffice produced no PDF. Check whether the document is password protected, damaged, or unsupported.',
      );
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > LIMITS.pdfBytes)
    throw new Error('LibreOffice produced an invalid or oversized output');
  const pdf = await readFile(converted);
  if (pdf.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('LibreOffice did not produce a valid PDF');
  return pdf;
}
