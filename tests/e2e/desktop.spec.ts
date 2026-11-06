import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { emlFixture, msgFixture, writeFixtures, writeOfficeFixture } from '../fixtures';

const execute = promisify(execFile);
test('terminal cancellation retains completed PDFs and removes the output lock', async () => {
  test.skip(process.platform === 'win32', 'Windows console Ctrl+C requires a terminal session');
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-cancel-'));
  const input = join(root, 'mail');
  const output = join(root, 'pdf');
  await mkdir(input);
  await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      writeFile(join(input, `message-${index}.eml`), emlFixture()),
    ),
  );
  const child = spawn(
    process.execPath,
    ['out/terminal/index.cjs', '-i', input, '-o', output, '--json'],
    {
      env: {
        ...process.env,
        MSG2PDF_ELECTRON_EXE: String(createRequire(import.meta.url)('electron')),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  try {
    await expect
      .poll(
        async () =>
          (await readdir(output).catch(() => [])).filter((name) => name.endsWith('.pdf')).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    child.kill('SIGINT');
    expect(await exited, stderr).toBe(130);
    const summary = JSON.parse(stdout);
    expect(summary.cancelled).toBe(true);
    expect(summary.converted).toBeGreaterThan(0);
    expect(summary.processed).toBeLessThan(30);
    expect(await readdir(output)).not.toContain('.msg2pdf.lock');
  } finally {
    child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('closing the desktop during conversion waits for worker and output cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-close-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await mkdir(input);
  await mkdir(output);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      writeFile(join(input, `mail-${index}.eml`), emlFixture()),
    ),
  );
  const application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, input);
    await page.getByRole('button', { name: 'Add a folder', exact: true }).click();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, output);
    await page.getByRole('button', { name: /Choose output folder/ }).click();
    await expect(page.getByRole('button', { name: 'Convert to PDF', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Convert to PDF', exact: true }).click();
    await expect.poll(async () => (await readdir(output)).includes('.msg2pdf.lock')).toBe(true);
    await application.close();
    expect(await readdir(output)).not.toContain('.msg2pdf.lock');
    expect((await readdir(output)).some((name) => name.startsWith('.msg2pdf-'))).toBe(false);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('optional real LibreOffice conversion uses the configured sandbox', async () => {
  test.skip(
    !process.env.MSG2PDF_TEST_OFFICE,
    'Set MSG2PDF_TEST_OFFICE to a current LibreOffice executable',
  );
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-office-integration-'));
  try {
    const input = await writeOfficeFixture(join(root, 'input'));
    const output = join(root, 'pdf');
    const result = await execute(
      process.execPath,
      [
        'scripts/cli.mjs',
        '-i',
        input,
        '-o',
        output,
        '--all-to-pdf',
        '--office',
        process.env.MSG2PDF_TEST_OFFICE ?? '',
        '--json',
      ],
      { timeout: 140_000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ converted: 1, failed: 0 });
    const pdf = await PDFDocument.load(await readFile(join(output, 'document.pdf')));
    expect(pdf.getPageCount()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('desktop converts real MSG/EML, safely previews MIME and exports a report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-desktop-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await writeFixtures(input);
  await mkdir(output);
  const application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  });
  const errors: string[] = [];
  try {
    const page = await application.firstWindow();
    await mkdir('artifacts', { recursive: true });
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Emails in. PDFs out.' })).toBeVisible();
    // Exercise the built CSS in Chromium: vendor-prefix minification must not
    // discard glass rendering, and the accessibility preference must still win.
    const material = await application.context().newCDPSession(page);
    await material.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
    });
    const glass = () =>
      page
        .locator('.panel')
        .first()
        .evaluate(
          (element) => element.ownerDocument.defaultView?.getComputedStyle(element).backdropFilter,
        );
    await expect.poll(glass).toContain('blur(');
    await material.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    await expect.poll(glass).toBe('none');
    await material.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
    });
    await page.screenshot({ path: 'artifacts/desktop-initial.png' });
    expect(await page.evaluate(() => typeof Reflect.get(globalThis, 'require'))).toBe('undefined');
    expect(await page.evaluate(() => typeof Reflect.get(globalThis, 'process'))).toBe('undefined');
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, input);
    await page.getByRole('button', { name: 'Add a folder', exact: true }).click();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, output);
    await page.getByRole('button', { name: /Choose output folder/ }).click();
    await expect(
      page.getByRole('list', { name: 'Conversion queue' }).getByRole('listitem'),
    ).toHaveCount(2);
    await page.getByRole('switch', { name: /Extract attachments/ }).check();
    await expect(page.getByRole('button', { name: 'Convert to PDF', exact: true })).toBeEnabled();
    expect(
      await page
        .locator('.page-body')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.getByRole('button', { name: /Preview message.eml/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const preview = page.frameLocator('iframe');
    await expect(preview.getByRole('heading', { name: 'Ready for review' })).toBeVisible();
    expect(await preview.locator('script').count()).toBe(0);
    expect(await preview.locator('img[src^="https:"]').count()).toBe(0);
    await page.screenshot({ path: 'artifacts/desktop-preview.png' });
    await page.getByRole('button', { name: 'Close preview' }).click();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/desktop-queue.png' });
    await page.getByRole('button', { name: 'Convert to PDF', exact: true }).click();
    await expect(page.getByText('Your batch is complete', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    for (const name of ['update.pdf', 'message.pdf']) {
      const pdf = await PDFDocument.load(await readFile(join(output, name)));
      expect(pdf.getPageCount()).toBeGreaterThan(0);
      expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 0);
    }
    expect(await readFile(join(output, 'message - notes.txt'), 'utf8')).toBe('Meeting notes.\n');
    expect(await readFile(join(output, 'update - notes.txt'), 'utf8')).toBe('Attached notes.\n');
    expect(await readdir(output)).not.toContain('.msg2pdf.lock');
    const report = join(root, 'report.json');
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, report);
    await page
      .getByRole('button', { name: /Export report/ })
      .first()
      .click();
    await expect
      .poll(async () => JSON.parse(await readFile(report, 'utf8').catch(() => 'null')))
      .toMatchObject({ converted: 2, failed: 0, attachments: 2 });
    await page.screenshot({ path: 'artifacts/desktop-complete.png' });
    await page.getByRole('button', { name: 'Recent activity', exact: true }).click();
    await expect(page.getByText(await realpath(output), { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/desktop-activity.png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: /Download installer/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Locate/ })).toBeVisible();
    await page.screenshot({ path: 'artifacts/desktop-settings.png' });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(980, 720),
    );
    await page.getByRole('button', { name: 'Converter', exact: true }).click();
    expect(
      await page
        .locator('.page-body')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: 'artifacts/desktop-compact.png' });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal produces clean JSON and real Letter PDFs, skips reruns and reports corrupt messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-terminal-'));
  try {
    const paths = await writeFixtures(join(root, 'input'));
    const rtf = join(root, 'rtf.msg');
    await writeFile(rtf, msgFixture({ rtf: String.raw`{\rtf1\ansi RTF-only email body.}` }));
    const output = join(root, 'output');
    const run = (...args: string[]) =>
      execute(process.execPath, ['scripts/cli.mjs', ...args], {
        cwd: resolve('.'),
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    const args = [
      '-i',
      paths.msg,
      paths.eml,
      rtf,
      '-o',
      output,
      '--json',
      '--extract-attachments',
      '--page-size',
      'Letter',
    ];
    const first = await run(...args);
    expect(JSON.parse(first.stdout)).toMatchObject({ converted: 3, attachments: 2, failed: 0 });
    const pdf = await PDFDocument.load(await readFile(join(output, 'update.pdf')));
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(612, 0);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(792, 0);
    expect(JSON.parse((await run(...args)).stdout)).toMatchObject({
      converted: 0,
      skipped: 3,
      attachments: 0,
    });
    await writeFile(join(root, 'broken.msg'), 'broken');
    const failure = await run('-i', join(root, 'broken.msg'), '-o', output, '--json').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect(JSON.parse(String(Reflect.get(failure as object, 'stdout')))).toMatchObject({
      failed: 1,
    });
    const help = await run('--help');
    expect(help.stdout).toContain('Exit codes:');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal continues safely after a rejected HTML body and preserves copied PDFs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-copy-'));
  try {
    const input = join(root, 'input');
    await mkdir(input);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const original = Buffer.from(await pdf.save());
    await writeFile(join(input, 'original.pdf'), original);
    await writeFile(join(input, 'mail.eml'), emlFixture());
    const output = join(root, 'out');
    const result = await execute(
      process.execPath,
      ['scripts/cli.mjs', '-i', input, '-o', output, '--all-to-pdf', '--json'],
      { timeout: 30_000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ converted: 1, copied: 1, failed: 0 });
    expect(await readFile(join(output, 'original.pdf'))).toEqual(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
