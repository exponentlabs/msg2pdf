import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 8 * 1024 * 1024,
});
if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
const groups = JSON.parse(result.stdout);
const packages = [
  {
    name: 'Poppins',
    version: 'Atlas bundled font snapshot',
    license: 'OFL-1.1',
    homepage: 'https://github.com/itfoundry/Poppins',
    notices: [{ file: 'OFL.txt', text: await readFile('resources/fonts/Poppins-OFL.txt', 'utf8') }],
  },
];
for (const entries of Object.values(groups)) {
  for (const entry of entries) {
    for (const [index, path] of entry.paths.entries()) {
      const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      const notices = [];
      for (const file of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        if (!file.isFile() || !/^(?:licen[sc]e|copying|notice|ofl)(?:[._-]|$)/i.test(file.name))
          continue;
        notices.push({ file: file.name, text: await readFile(join(path, file.name), 'utf8') });
      }
      if (!notices.length) throw new Error(`Missing upstream license text for ${entry.name}`);
      packages.push({
        name: entry.name,
        version: metadata.version ?? entry.versions[index],
        license: entry.license,
        homepage: metadata.homepage ?? '',
        notices,
      });
    }
  }
}
packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
await mkdir('resources', { recursive: true });
await writeFile('resources/third-party-notices.json', `${JSON.stringify(packages, null, 2)}\n`);
const separator = `\n\n${'='.repeat(78)}\n`;
let text =
  'msg2pdf — Third-party notices\n\nOriginal msg2pdf code and documentation are licensed under Apache-2.0.\nSee the project LICENSE and NOTICE. Third-party components and assets retain\ntheir own licences, reproduced below.\n\nElectron/Chromium notices are also shipped beside the application runtime as\nLICENSE.electron.txt and LICENSES.chromium.html (names vary by platform).\n';
for (const entry of packages) {
  text += `${separator}${entry.name}@${entry.version} — ${entry.license}\n${entry.homepage}\n`;
  for (const notice of entry.notices) text += `\n${notice.file}\n${notice.text}\n`;
}
text += `${separator}Electron\n${await readFile('node_modules/electron/LICENSE', 'utf8')}\n`;
await writeFile('resources/THIRD_PARTY_NOTICES.txt', text);
console.log(`Collected upstream notices for ${packages.length} production packages.`);
