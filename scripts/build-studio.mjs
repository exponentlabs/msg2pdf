import { cp, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

export async function buildStudio() {
  const target = 'out/studio';
  await mkdir(target, { recursive: true });
  for (const name of ['engine.html', 'engine.mjs'])
    await cp(`src/main/studio/${name}`, `${target}/${name}`);
  for (const name of ['verify.cjs', 'raster-policy.cjs', 'evaluation-contract.json'])
    await cp(`scripts/b1/${name}`, `${target}/${name}`);
  for (const name of ['pdf.mjs', 'pdf.worker.mjs'])
    await cp(`node_modules/pdfjs-dist/build/${name}`, `${target}/${name}`);
  for (const name of ['standard_fonts', 'cmaps', 'wasm'])
    await cp(`node_modules/pdfjs-dist/${name}`, `${target}/${name}`, { recursive: true });
  await build({
    entryPoints: ['src/main/studio/assemble.mjs'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: `${target}/assemble.cjs`,
  });
}
