import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { StudioApi } from '../../src/shared/studio';

test('Fedora studio captures fixed pages, marks, reviews and reopens durable plans', async () => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'arm64',
    'Fedora ARM64 studio profile requires its native runtime and system verifiers',
  );
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-studio-ui-'));
  const working = join(root, 'Working case');
  await mkdir(working);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 400]);
  page.drawText('SECRET CANARY', { x: 40, y: 300, font, size: 14 });
  page.drawText('PUBLIC NEIGHBOR', { x: 40, y: 240, font, size: 14 });
  page.drawRectangle({ x: 40, y: 100, width: 100, height: 40, color: rgb(0, 0.8, 0) });
  const input = join(root, 'synthetic.pdf');
  await writeFile(input, await pdf.save());
  const application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const window = await application.firstWindow();
    await window.getByRole('button', { name: 'Redaction studio', exact: true }).click();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, working);
    await expect(
      window.getByRole('button', { name: 'New working folder', exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    await window.getByRole('button', { name: 'New working folder', exact: true }).click();
    await expect(
      window.getByRole('heading', { name: basename(working), exact: true }),
    ).toBeVisible();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, input);
    await window.getByRole('button', { name: 'Add PDFs', exact: true }).click();
    await expect(window.getByRole('button', { name: /synthetic.pdf/ })).toBeVisible();
    await window.getByRole('button', { name: /synthetic.pdf/ }).click();
    await window.getByRole('button', { name: 'Prepare fixed pages', exact: true }).click();
    await expect(window.getByRole('img', { name: 'Fixed review page 1' })).toBeVisible({
      timeout: 45_000,
    });
    const surface = window.getByRole('application', { name: 'Drag to mark redaction regions' });
    await surface.scrollIntoViewIfNeeded();
    const bounds = await surface.boundingBox();
    if (!bounds) throw new Error('No review page');
    await window.mouse.move(bounds.x + 35, bounds.y + 75);
    await window.mouse.down();
    await window.mouse.move(bounds.x + 220, bounds.y + 110);
    await window.mouse.up();
    await expect(window.locator('.studio-mark')).toHaveCount(1);
    await expect(window.getByRole('button', { name: 'Undo marks' })).toBeEnabled();
    await window.getByRole('button', { name: 'Mark page reviewed', exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Mark page unreviewed', exact: true }),
    ).toBeVisible();
    const saved = await window.evaluate(
      async () => (await (Reflect.get(globalThis, 'studio') as StudioApi).status()).case?.state,
    );
    expect(saved?.documents[0]?.plan?.marks).toHaveLength(1);
    expect(saved?.documents[0]?.plan?.reviewedPages).toEqual([0]);
    await expect(
      window.evaluate(() =>
        (Reflect.get(globalThis, 'studio') as StudioApi).saveMarks({
          id: 'forged',
          version: 0,
          revisionHash: 'forged',
          marks: [],
        }),
      ),
    ).rejects.toThrow();
    await window.getByRole('button', { name: 'Close case', exact: true }).click();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, working);
    await window.getByRole('button', { name: 'Open working folder', exact: true }).click();
    await window.getByRole('button', { name: /synthetic.pdf/ }).click();
    await expect(window.locator('.studio-mark')).toHaveCount(1);
    await expect(
      window.getByRole('button', { name: 'Mark page unreviewed', exact: true }),
    ).toBeVisible();
    await window.getByRole('button', { name: 'Create image-only candidate', exact: true }).click();
    await expect(
      window.getByRole('button', { name: 'Review sanitized page 1', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    const candidate = await window.evaluate(
      async () =>
        (await (Reflect.get(globalThis, 'studio') as StudioApi).status()).case?.state.documents[0]
          ?.candidate,
    );
    expect(candidate?.checks.every((check) => check.passed)).toBe(true);
    expect(candidate?.review).toBeUndefined();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const opened = application.waitForEvent('window');
    await window.getByRole('button', { name: 'Review sanitized page 1', exact: true }).click();
    const preview = await opened;
    await expect(
      preview.getByRole('heading', { name: 'Sanitized candidate — page 1 of 1' }),
    ).toBeVisible();
    await preview.screenshot({ path: 'artifacts/studio-candidate.png' });
    await application.evaluate(({ BrowserWindow }) => {
      const preview = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('app://studio-candidate/'),
      );
      if (!preview) throw new Error('Missing candidate preview');
      preview.close();
    });
    await expect(
      window.getByText('Independently verified · 1/1 candidate pages reviewed', { exact: true }),
    ).toBeVisible();
    await window
      .getByRole('button', { name: 'Approve selected document release', exact: true })
      .click();
    await window.getByRole('button', { name: 'Publish approved release', exact: true }).click();
    await expect(window.getByText('1 immutable releases', { exact: true })).toBeVisible();
    await mkdir('artifacts', { recursive: true });
    await window.screenshot({ path: 'artifacts/studio-review.png' });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
