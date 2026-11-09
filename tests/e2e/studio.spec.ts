import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from 'pdf-lib';
import type { StudioApi } from '../../src/shared/studio';
import { msgFixture } from '../fixtures';

test('Fedora studio captures fixed pages, marks, reviews and reopens durable plans', async () => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'arm64',
    'Fedora ARM64 studio profile requires its native runtime and system verifiers',
  );
  test.setTimeout(120_000);
  const root = await mkdtemp(
    join(process.env.MSG2PDF_STUDIO_TEST_ROOT ?? tmpdir(), 'msg2pdf-studio-ui-'),
  );
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
    await window.getByRole('button', { name: 'Add documents', exact: true }).click();
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
    await window.getByText('Mark a region using the keyboard', { exact: true }).click();
    for (const [label, value] of [
      ['left', '40'],
      ['bottom', '100'],
      ['right', '140'],
      ['top', '140'],
    ])
      await window
        .getByRole('spinbutton', { name: `Region ${label}`, exact: true })
        .fill(value ?? '');
    await window.getByRole('button', { name: 'Add coordinate region', exact: true }).focus();
    await window.keyboard.press('Enter');
    await expect(window.locator('.studio-mark')).toHaveCount(2);
    await window.getByRole('button', { name: 'Undo marks', exact: true }).click();
    await expect(window.locator('.studio-mark')).toHaveCount(1);
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
    const exportPath = process.env.MSG2PDF_STUDIO_CASE_EXPORT;
    await expect(
      window.getByRole('button', { name: 'Publish approved release', exact: true }),
    ).toBeEnabled();
    if (exportPath) {
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, exportPath);
      await window.evaluate(async () => (Reflect.get(globalThis, 'studio') as StudioApi).backup());
    }
    await window.getByRole('button', { name: 'Publish approved release', exact: true }).click();
    await expect(window.getByText('1 immutable releases', { exact: true })).toBeVisible();
    const nativeWindow = await application.browserWindow(window);
    await nativeWindow.evaluate((window) => window.setContentSize(980, 720));
    await expect.poll(() => window.evaluate('innerWidth')).toBe(980);
    expect(
      await window.evaluate(
        'document.documentElement.scrollWidth <= document.documentElement.clientWidth',
      ),
    ).toBe(true);
    await mkdir('artifacts', { recursive: true });
    await window.screenshot({ path: 'artifacts/studio-review.png' });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('mixed Fedora case inventories nested email attachments and prepares sandboxed Office', async () => {
  test.skip(process.platform !== 'linux' || process.arch !== 'arm64', 'Fedora ARM64 profile');
  test.setTimeout(120_000);
  const root = await mkdtemp(
    join(process.env.MSG2PDF_STUDIO_TEST_ROOT ?? tmpdir(), 'msg2pdf-studio-mixed-'),
  );
  const working = join(root, 'case');
  await mkdir(working);
  const nested =
    'From: nested@example.test\r\nSubject: Nested message\r\nContent-Type: text/plain\r\n\r\nNested body';
  const email = [
    'From: synthetic@example.test',
    'To: reviewer@example.test',
    'Subject: Family fixture',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="studio"',
    '',
    '--studio',
    'Content-Type: text/plain',
    '',
    'Public email body. Review the printed attachment title.',
    '--studio',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="nested.eml"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(nested).toString('base64'),
    '--studio',
    'Content-Type: application/zip',
    'Content-Disposition: attachment; filename="private-title.zip"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('Opaque archive fixture').toString('base64'),
    '--studio--',
    '',
  ].join('\r\n');
  const input = join(root, 'parent.eml');
  const office = join(root, 'letter.rtf');
  await writeFile(input, email);
  await writeFile(office, '{\\rtf1\\ansi Synthetic public Office paragraph.}');
  const embeddedPdf = join(root, 'embedded.pdf');
  const embedded = await PDFDocument.create();
  embedded.addPage([300, 300]).drawText('Public PDF with a private attachment');
  await embedded.attach(Buffer.from('PRIVATE_EMBEDDED_BYTES'), 'attachment-sensitive.txt');
  const associated = embedded.context.register(
    embedded.context.flateStream(Buffer.from('ASSOCIATED_PRIVATE_BYTES'), { Type: 'EmbeddedFile' }),
  );
  embedded.catalog.set(
    PDFName.of('AF'),
    embedded.context.obj([
      embedded.context.register(
        embedded.context.obj({
          Type: 'Filespec',
          UF: PDFString.of('associated-sensitive.txt'),
          EF: { F: associated },
        }),
      ),
    ]),
  );
  embedded.context.register(
    embedded.context.flateStream(Buffer.from('ORPHAN_PRIVATE_BYTES'), { Type: 'EmbeddedFile' }),
  );
  await writeFile(embeddedPdf, await embedded.save());
  const msg = join(root, 'message.msg');
  await writeFile(msg, msgFixture({ html: '<p>Public MSG body.</p>' }));
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
    ).toBeEnabled();
    await window.getByRole('button', { name: 'New working folder', exact: true }).click();
    await expect(window.getByRole('heading', { name: 'case', exact: true })).toBeVisible();
    await application.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      },
      [input, office, embeddedPdf, msg],
    );
    const captured = await window.evaluate(async () =>
      (Reflect.get(globalThis, 'studio') as StudioApi).import(),
    );
    const parentId = captured.case?.state.documents[0]?.id;
    const officeId = captured.case?.state.documents[1]?.id;
    if (!parentId || !officeId) throw new Error('Missing mixed sources');
    const prepared = await window.evaluate(async (id) => {
      const api = Reflect.get(globalThis, 'studio') as StudioApi;
      return api.prepare({ id, version: (await api.status()).case?.state.version ?? -1 });
    }, parentId);
    expect(prepared.case?.state.documents).toHaveLength(6);
    const family = prepared.case?.state.families[0];
    expect(family?.inventoryComplete).toBe(true);
    expect(family?.members).toHaveLength(3);
    expect(
      Object.values(family?.dispositions ?? {}).filter((item) => item.kind === 'unresolved'),
    ).toHaveLength(2);
    const nestedId = Object.entries(prepared.case?.names ?? {}).find(
      ([, name]) => name === 'nested.eml',
    )?.[0];
    if (!nestedId) throw new Error('Missing nested source');
    const nestedPrepared = await window.evaluate(async (id) => {
      const api = Reflect.get(globalThis, 'studio') as StudioApi;
      return api.prepare({ id, version: (await api.status()).case?.state.version ?? -1 });
    }, nestedId);
    expect(
      nestedPrepared.case?.state.documents.find((item) => item.id === nestedId)?.revision
        ?.converter,
    ).toContain('email/Chromium');
    const officePrepared = await window.evaluate(async (id) => {
      const api = Reflect.get(globalThis, 'studio') as StudioApi;
      return api.prepare({ id, version: (await api.status()).case?.state.version ?? -1 });
    }, officeId);
    expect(
      officePrepared.case?.state.documents.find((item) => item.id === officeId)?.revision
        ?.converter,
    ).toContain('LibreOffice 26.2.7');
    if (!family) throw new Error('Missing family');
    const excluded = await window.evaluate(
      async ({ familyId, documentId }) => {
        const api = Reflect.get(globalThis, 'studio') as StudioApi;
        return api.disposition({
          familyId,
          documentId,
          version: (await api.status()).case?.state.version ?? -1,
          kind: 'exclude',
          reason: 'Deliberately omit native attachment from this release',
        });
      },
      { familyId: family.id, documentId: family.members[2] ?? '' },
    );
    expect(excluded.case?.state.families[0]?.dispositions[family.members[2] ?? '']?.kind).toBe(
      'exclude',
    );
    for (const name of ['embedded.pdf', 'message.msg']) {
      const id = Object.entries(excluded.case?.names ?? {}).find(
        ([, value]) => value === name,
      )?.[0];
      if (!id) throw new Error('Missing format fixture');
      const result = await window.evaluate(async (id) => {
        const api = Reflect.get(globalThis, 'studio') as StudioApi;
        return api.prepare({ id, version: (await api.status()).case?.state.version ?? -1 });
      }, id);
      expect(result.case?.state.documents.find((item) => item.id === id)?.revision).toBeDefined();
      if (name === 'embedded.pdf')
        expect(Object.values(result.case?.names ?? {})).toContain('attachment-sensitive.txt');
      if (name === 'embedded.pdf') {
        expect(Object.values(result.case?.names ?? {})).toContain('associated-sensitive.txt');
        expect(
          Object.values(result.case?.names ?? {}).some((label) =>
            label.startsWith('embedded-data-'),
          ),
        ).toBe(true);
      }
    }
    // Release a deliberate mixed-case subset, requiring explicit family decisions.
    await window.evaluate(async (id) => {
      const api = Reflect.get(globalThis, 'studio') as StudioApi;
      let state = (await api.status()).case?.state;
      const doc = state?.documents.find((item) => item.id === id);
      if (!state || !doc?.revision) throw new Error('No email revision');
      for (let page = 0; page < doc.revision.pages.length; page++) {
        await api.reviewPage({
          id,
          version: state.version,
          revisionHash: doc.revision.hash,
          page,
          decision: 'reviewed',
        });
        state = (await api.status()).case?.state;
        if (!state) throw new Error('No state');
      }
      await api.apply({ id, version: state.version });
    }, parentId);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const review = async () => {
      const opened = application.waitForEvent('window');
      const pending = window.evaluate(async (id) => {
        const api = Reflect.get(globalThis, 'studio') as StudioApi;
        const state = (await api.status()).case?.state;
        const candidate = state?.documents.find((item) => item.id === id)?.candidate;
        if (!state || !candidate) throw new Error('No candidate');
        return api.reviewCandidate({
          id,
          version: state.version,
          candidateHash: candidate.hash,
          page: 0,
        });
      }, parentId);
      const preview = await opened;
      await expect(
        preview.getByRole('heading', { name: 'Sanitized candidate — page 1 of 1' }),
      ).toBeVisible();
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().startsWith('app://studio-candidate/'))
          ?.close();
      });
      await pending;
    };
    await review();
    await expect(
      window.evaluate(async (id) => {
        const api = Reflect.get(globalThis, 'studio') as StudioApi;
        return api.approveRelease({
          selection: [id],
          version: (await api.status()).case?.state.version ?? -1,
        });
      }, parentId),
    ).rejects.toThrow('FAMILY_UNRESOLVED');
    await window.evaluate(
      async ({ familyId, nestedId }) => {
        const api = Reflect.get(globalThis, 'studio') as StudioApi;
        return api.disposition({
          version: (await api.status()).case?.state.version ?? -1,
          familyId,
          documentId: nestedId,
          kind: 'exclude',
          reason: 'Deliberately omit nested message from this subset',
        });
      },
      { familyId: family.id, nestedId },
    );
    await review();
    const released = await window.evaluate(async (id) => {
      const api = Reflect.get(globalThis, 'studio') as StudioApi;
      const approved = await api.approveRelease({
        selection: [id],
        version: (await api.status()).case?.state.version ?? -1,
      });
      return api.publish({ version: approved.case?.state.version ?? -1 });
    }, parentId);
    expect(
      released.case?.state.releases?.[0]?.approval.manifest.files.map((file) => file.documentId),
    ).toEqual([parentId]);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
