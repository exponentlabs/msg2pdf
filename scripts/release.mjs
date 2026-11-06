import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import signing from './signing.cjs';

// Check credentials before removing generated files or starting a build.
signing.validateSigningEnvironment(process.platform, process.env);
const env = { ...process.env, MSG2PDF_RELEASE: '1' };
const output = 'release/public';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}
function pnpm(script) {
  run('pnpm', [script], { shell: process.platform === 'win32' });
}

await rm(output, { recursive: true, force: true });
pnpm('package');
pnpm('test:packaged');

if (process.platform === 'darwin') {
  const app = join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'msg2pdf.app');
  run('codesign', ['--verify', '--deep', '--strict', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose', app]);
} else if (process.platform === 'win32') {
  run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'
$root = $env:MSG2PDF_RELEASE_DIRECTORY
$folder = if ($env:MSG2PDF_RELEASE_ARCH -eq 'arm64') { 'win-arm64-unpacked' } else { 'win-unpacked' }
$files = @((Join-Path $root "$folder/msg2pdf.exe"), (Join-Path $root "$folder/resources/native/office-sandbox.exe"))
$installers = @(Get-ChildItem -LiteralPath $root -Filter '*.exe' -File)
if ($installers.Count -eq 0) { throw 'Missing Windows installer' }
$files += $installers.FullName
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
    throw "Missing valid timestamped signature: $file"
  }
}`,
    ],
    {
      env: {
        ...env,
        MSG2PDF_RELEASE_DIRECTORY: resolve(output),
        MSG2PDF_RELEASE_ARCH: process.arch,
      },
    },
  );
}

pnpm('source:archive');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const files = (await readdir(output))
  .filter(
    (name) =>
      name === 'msg2pdf-source.tar.gz' ||
      (name.startsWith(`msg2pdf-${version}-`) && /\.(?:dmg|zip|exe|AppImage|deb)$/.test(name)),
  )
  .sort();
if (files.length < 2) throw new Error('Release artifacts are incomplete.');
const checksums = [];
for (const name of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(output, name))) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
console.log(`Verified ${files.length} release artifacts in ${output}. Nothing was published.`);
