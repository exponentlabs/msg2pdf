const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

function checkDocs(root) {
  const files = [];
  function collect(directory, recursive) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
      else if (recursive && entry.isDirectory()) collect(path, true);
    }
  }
  collect(root, false);
  for (const directory of ['docs', '.github']) {
    if (existsSync(join(root, directory))) collect(join(root, directory), true);
  }
  const errors = [];
  let links = 0;
  for (const file of files) {
    const body = readFileSync(file, 'utf8').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
    const pattern = /!?\[[^\]\n]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'][^)]*)?\s*\)/g;
    for (const match of body.matchAll(pattern)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (target.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      links++;
      const path = resolve(dirname(file), decodeURIComponent(target.split(/[?#]/)[0]));
      const local = relative(resolve(root), path);
      if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || !existsSync(path))
        errors.push(`${relative(root, file)}: missing or out-of-repository target ${target}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { files: files.length, links };
}

module.exports = { checkDocs };
if (require.main === module) {
  const result = checkDocs(process.cwd());
  console.log(`Checked ${result.links} local file links in ${result.files} Markdown documents.`);
}
