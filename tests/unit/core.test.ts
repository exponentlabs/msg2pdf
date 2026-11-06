import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeHtml, parseEmailBytes, parseEmailFile } from '../../src/core/email';
import type { ConversionServices } from '../../src/core/engine';
import { runConversion } from '../../src/core/engine';
import { atomicWrite, inspectOutput } from '../../src/core/filesystem';
import { buildEmailHtml, sanitizeBody } from '../../src/core/html';
import { lockOutput } from '../../src/core/lock';
import {
  attachmentLeaf,
  limitedName,
  NameAllocator,
  pdfNames,
  safeName,
} from '../../src/core/names';
import { officeSandbox, supportedOfficeVersion } from '../../src/core/office';
import { createPlan } from '../../src/core/planner';
import { runProcess } from '../../src/core/process';
import { decodeRtfBody } from '../../src/core/rtf';
import { optionsSchema } from '../../src/shared/contracts';
import { originKey } from '../../src/shared/security';
import { parseArguments, terminalText } from '../../src/terminal/arguments';
import { emlFixture, msgFixture, writeFixtures } from '../fixtures';

const temporary: string[] = [];
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'msg2pdf-test-'));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const options = optionsSchema.parse({ recursive: true, allToPdf: true });

describe('portable naming', () => {
  it.each(['CON', 'aux.txt', 'COM¹.docx', 'LPT9', 'conout$'])(
    'protects Windows device name %s',
    (name) => expect(safeName(name)).toBe(`_${name}`),
  );
  it('removes paths, controls and trailing dots', () => {
    expect(safeName('a\u0007<b>:c?. ')).toBe('a__b__c_');
    expect(attachmentLeaf('C:\\outside\\../../report.txt', 0)).toBe('report.txt');
    expect(attachmentLeaf('..', 2)).toBe('attachment-3');
    expect(Buffer.byteLength(limitedName(`${'😀'.repeat(100)}.pdf`))).toBeLessThanOrEqual(220);
  });
  it('preserves PDFs and colliding original extensions', () => {
    expect(pdfNames(['report.eml', 'REPORT.msg', 'report.pdf'])).toEqual([
      'report.eml.pdf',
      'REPORT.msg.pdf',
      'report.pdf',
    ]);
    expect(pdfNames(['file.eml'], ['file.pdf'])).toEqual(['file (2).pdf']);
  });
  it('allocates Unicode and case collisions efficiently', () => {
    const allocator = new NameAllocator(['Café.txt']);
    expect(allocator.allocate('CAFE\u0301.txt')).toBe('CAFÉ (2).txt');
    for (let n = 0; n < 10_000; n++) allocator.allocate('duplicate.txt');
    expect(allocator.allocate('duplicate.txt')).toBe('duplicate (10001).txt');
  });
});
describe('message normalization and HTML isolation', () => {
  it('bounds metadata before sending it to a desktop renderer', async () => {
    await expect(
      parseEmailBytes(msgFixture({ subject: 'x'.repeat(65_537) }), '.msg'),
    ).rejects.toThrow('metadata');
  });
  it('preserves MIME inline-disposition resources that are not displayed in the body', async () => {
    const message = await parseEmailBytes(
      Buffer.from(emlFixture().replace('<img src="cid:logo">', '')),
      '.eml',
    );
    expect(
      message.attachments
        .filter((attachment) => !attachment.inline)
        .map((attachment) => attachment.name),
    ).toEqual(['logo.png', 'notes.txt']);
  });
  it('decodes the standard MAPI RTF property without requiring LibreOffice', async () => {
    const message = await parseEmailBytes(
      msgFixture({ rtf: String.raw`{\rtf1\ansi A simple \b RTF\b0\par message.}` }),
      '.msg',
    );
    expect(message.text).toBe('A simple RTF\r\nmessage.');
  });
  it('reads signed MSG MIME and rejects encrypted mail or truncated multipart bodies', async () => {
    const message = await parseEmailBytes(
      msgFixture({
        messageClass: 'IPM.Note.SMIME.MultipartSigned',
        mime: Buffer.from(emlFixture()),
      }),
      '.msg',
    );
    expect(message.html).toContain('Ready for review');
    expect(message.attachments.some((attachment) => attachment.name === 'notes.txt')).toBe(true);
    await expect(
      parseEmailBytes(msgFixture({ messageClass: 'IPM.Note.SMIME' }), '.msg'),
    ).rejects.toThrow('decrypted');
    await expect(
      parseEmailBytes(Buffer.from(emlFixture().replace('--mixed--', '')), '.eml'),
    ).rejects.toThrow('Truncated');
  });
  it('renders ordinary RTF text, Unicode, codepages and line breaks without binary drawing data', async () => {
    const result = await decodeRtfBody(
      Buffer.from(
        String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl{\f0 Arial;}}Hello \b world\b0\par Caf\'e9 \u9731?{\pict\pngblip 89504e47}}`,
      ),
    );
    expect(result.text).toBe('Hello world\r\nCafé ☃');
    expect(result.html).toBe('');
  });
  it('rejects invalid or pathological RTF', async () => {
    await expect(decodeRtfBody(Buffer.from('invalid'))).rejects.toThrow('Invalid RTF');
    await expect(decodeRtfBody(Buffer.from(String.raw`{\rtf1\bin4000000000 }`))).rejects.toThrow();
  });
  it('parses synthetic MSG including cp1252 HTML and embedded attachments', async () => {
    const message = await parseEmailBytes(
      msgFixture({ html: '<p>It’s ready — café.</p>', attachment: true }),
      '.msg',
    );
    expect(message.subject).toBe('Café project update');
    expect(message.html).toContain('It’s ready — café.');
    expect(message.sender).toContain('alex@example.test');
    expect(Buffer.from(message.attachments[0]?.data ?? []).toString()).toBe('Attached notes.\n');
  });
  it('parses EML MIME, resolves CIDs and leaves ordinary attachments extractable', async () => {
    const message = await parseEmailBytes(Buffer.from(emlFixture()), '.eml');
    expect(message.html).toContain('data:image/png;base64,');
    expect(message.html).not.toMatch(/tracker|<script|pwned/);
    expect(message.attachments.filter((a) => !a.inline).map((a) => a.name)).toEqual(['notes.txt']);
    expect(message.recipients).toContain('taylor@example.test');
  });
  it('blocks scripts, SVG, forms, network/local images, hostile CSS and active URLs', () => {
    const html = sanitizeBody(
      '<script>bad()</script><svg><script>bad()</script></svg><form action="https://evil.test"><input></form><img src="file:///etc/passwd" onerror="bad()"><a href="javascript:bad()">link</a><p style="position:fixed;background-image:url(https://evil.test);color:red">safe</p>',
    );
    expect(html).not.toMatch(/bad|evil|passwd|onerror|position|<svg|<form|<input/);
    expect(html).toContain('color:red');
  });
  it('escapes metadata and preserves plain-text line breaks', async () => {
    const message = await parseEmailBytes(msgFixture({ text: 'one\ntwo <three>' }), '.msg');
    message.subject = '<img src=x onerror=alert(1)>';
    const html = buildEmailHtml(message, 'Letter');
    expect(html).toContain('&lt;img');
    expect(html).toContain('one\ntwo &lt;three&gt;');
    expect(html).toContain('@page{size:Letter');
  });
  it('rejects malformed messages and accepts declared legacy encodings', async () => {
    await expect(parseEmailBytes(Buffer.from('not an email'), '.eml')).rejects.toThrow(
      'Invalid EML',
    );
    await expect(parseEmailBytes(Buffer.from('not MSG'), '.msg')).rejects.toThrow();
    expect(decodeHtml(Buffer.from('<meta charset="windows-1252">\x80', 'latin1'))).toContain('€');
  });
});
describe('discovery and safe output', () => {
  it('excludes nested outputs, deduplicates inputs and keeps separate colliding destinations', async () => {
    const root = await workspace();
    const input = join(root, 'input');
    await writeFixtures(input);
    await writeFile(join(input, 'update.eml'), emlFixture());
    const output = join(input, 'output');
    await mkdir(output);
    await writeFile(join(output, 'old.eml'), emlFixture());
    const plan = await createPlan({ inputs: [input, join(input, 'update.msg')], output, options });
    expect(plan.files).toHaveLength(3);
    expect(new Set(plan.files.map((f) => f.destination)).size).toBe(3);
    expect(plan.files.some((f) => f.name === 'old.eml')).toBe(false);
  });
  it('rejects output containing input and reserves directory names', async () => {
    const root = await workspace();
    const input = join(root, 'input');
    await writeFixtures(input);
    await mkdir(join(input, 'message.pdf'));
    await writeFile(join(input, 'message.pdf', 'nested.eml'), emlFixture());
    await expect(createPlan({ inputs: [input], output: root, options })).rejects.toThrow(
      'separate output',
    );
    const plan = await createPlan({ inputs: [input], output: join(root, 'out'), options });
    expect(basename(plan.files.find((f) => f.name === 'message.eml')?.destination ?? '')).toBe(
      'message (2).pdf',
    );
  });
  it('commits complete files atomically and refuses no-overwrite races', async () => {
    const root = await workspace();
    const path = join(root, 'nested', 'file.pdf');
    const writes = await Promise.all([
      atomicWrite(path, root, Buffer.from('first'), false),
      atomicWrite(path, root, Buffer.from('second'), false),
    ]);
    expect(writes.sort()).toEqual([false, true]);
    expect(['first', 'second']).toContain(await readFile(path, 'utf8'));
    expect(await readdir(join(root, 'nested'))).toEqual(['file.pdf']);
    await expect(
      atomicWrite(join(root, '..', 'escaped.pdf'), root, Buffer.from('x'), true),
    ).rejects.toThrow('escapes');
  });
  it.skipIf(process.platform === 'win32')(
    'refuses symlinks in output paths and skips symlink inputs',
    async () => {
      const root = await workspace();
      const input = join(root, 'input');
      await writeFixtures(input);
      await symlink(join(input, 'message.eml'), join(input, 'link.eml'));
      const output = join(root, 'out');
      await mkdir(output);
      await symlink(input, join(output, 'escape'));
      await expect(inspectOutput(join(output, 'escape', 'x.pdf'), output, true)).rejects.toThrow(
        'symlink',
      );
      const plan = await createPlan({ inputs: [input], output, options });
      expect(plan.files).toHaveLength(2);
      expect(plan.issues[0]?.message).toContain('Symbolic');
    },
  );
  it('serializes batches and releases locks on failures', async () => {
    const root = await workspace();
    const release = await lockOutput(root);
    await expect(lockOutput(root)).rejects.toThrow('locked');
    await release();
    const again = await lockOutput(root);
    await again();
  });
});
describe('shared conversion engine', () => {
  it('keeps the primary PDF and extracts later attachments when one attachment fails', async () => {
    const root = await workspace();
    const input = await writeFixtures(join(root, 'input'));
    const plan = await createPlan({
      inputs: [input.eml],
      output: join(root, 'out'),
      options: { ...options, extractAttachments: true },
    });
    const message = await parseEmailFile(input.eml);
    message.attachments.unshift({
      name: 'external.txt',
      contentType: 'text/plain',
      contentId: '',
      hidden: false,
      inline: false,
      data: null,
    });
    const services: ConversionServices = {
      parseEmail: async () => message,
      renderPdf: async () => Buffer.from('%PDF-test'),
      convertOffice: async () => false,
    };
    const summary = await runConversion(plan, services, () => {});
    expect(summary).toMatchObject({ converted: 1, failed: 1, attachments: 1 });
    expect(summary.results[0]?.status).toBe('partial');
    expect(await readFile(join(plan.output, 'message.pdf'), 'utf8')).toBe('%PDF-test');
    expect(await readFile(join(plan.output, 'message - notes.txt'), 'utf8')).toBe(
      'Meeting notes.\n',
    );
  });
  async function setup() {
    const root = await workspace();
    const input = join(root, 'input');
    await writeFixtures(input);
    const plan = await createPlan({
      inputs: [input],
      output: join(root, 'out'),
      options: { ...options, extractAttachments: true },
    });
    const services: ConversionServices = {
      parseEmail: parseEmailFile,
      renderPdf: vi.fn(async () => Buffer.from('%PDF-test')),
      convertOffice: vi.fn(async () => true),
    };
    return { root, plan, services };
  }
  it('extracts ordinary attachments safely and skips existing PDFs on rerun', async () => {
    const { plan, services } = await setup();
    const summary = await runConversion(plan, services, () => {});
    expect(summary).toMatchObject({ converted: 2, failed: 0, attachments: 2 });
    expect(await readFile(join(plan.output, 'update - notes.txt'), 'utf8')).toBe(
      'Attached notes.\n',
    );
    expect(await readdir(plan.output)).not.toContain('.msg2pdf.lock');
    const second = await runConversion(plan, services, () => {});
    expect(second).toMatchObject({ converted: 0, skipped: 2, attachments: 0 });
  });
  it('continues after a failed message and reports the failure', async () => {
    const { plan, services } = await setup();
    services.parseEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error('Malformed message'))
      .mockImplementation(parseEmailFile);
    const summary = await runConversion(plan, services, () => {});
    expect(summary).toMatchObject({ converted: 1, failed: 1, processed: 2 });
  });
  it('cancels the current file, retains completed outputs and releases its lock', async () => {
    const { plan, services } = await setup();
    const controller = new AbortController();
    services.renderPdf = async () => {
      controller.abort();
      return Buffer.from('%PDF-incomplete');
    };
    const summary = await runConversion(plan, services, () => {}, controller.signal);
    expect(summary.cancelled).toBe(true);
    expect(summary.results[0]?.status).toBe('cancelled');
    expect(summary.converted).toBe(0);
    expect(
      (await readdir(plan.output)).every(
        (name) => !name.endsWith('.pdf') && name !== '.msg2pdf.lock',
      ),
    ).toBe(true);
  });
});
describe('terminal and worker contracts', () => {
  it.skipIf(process.platform !== 'darwin')(
    'Office sandbox cannot reach a local TCP server',
    async () => {
      const root = await workspace();
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.end('pong');
      });
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test port');
        const args = [
          '--noproxy',
          '*',
          '--connect-timeout',
          '1',
          `http://127.0.0.1:${address.port}/`,
        ];
        expect((await runProcess('/usr/bin/curl', args, { timeoutMs: 3000 })).stdout).toBe('pong');
        const sandbox = await officeSandbox('/usr/bin/curl', args, root, 'unused');
        await expect(
          runProcess(sandbox.executable, sandbox.args, { timeoutMs: 3000 }),
        ).rejects.toThrow('Worker failed');
        expect(requests).toBe(1);
      } finally {
        await new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        );
      }
    },
  );
  it.skipIf(process.platform !== 'darwin')(
    'Office sandbox permits the private workspace and blocks unrelated files',
    async () => {
      const root = await workspace();
      const scratch = join(root, 'private');
      await mkdir(scratch);
      const allowed = join(scratch, 'allowed.txt');
      await writeFile(allowed, 'allowed');
      const secret = join(root, 'secret.txt');
      await writeFile(secret, 'not readable');
      const yes = await officeSandbox('/bin/cat', [allowed], scratch, 'unused');
      expect((await runProcess(yes.executable, yes.args, { timeoutMs: 5000 })).stdout).toBe(
        'allowed',
      );
      const no = await officeSandbox('/bin/cat', [secret], scratch, 'unused');
      await expect(runProcess(no.executable, no.args, { timeoutMs: 5000 })).rejects.toThrow(
        'Worker failed',
      );
    },
  );
  it('keeps custom-scheme origins distinct', () => {
    expect(originKey('app://ui/index.html')).toBe('app://ui');
    expect(originKey('app://evil/index.html')).not.toBe(originKey('app://ui/index.html'));
    expect(originKey('https://example.test/path')).toBe('https://example.test');
  });
  it('validates CLI options and strips terminal escape/control sequences', () => {
    const args = parseArguments(['-i', 'a.msg', '-o', 'out', '--json', '--page-size', 'Letter']);
    expect(args).toMatchObject({ json: true, request: { options: { pageSize: 'Letter' } } });
    expect(() => parseArguments(['-i', 'a.msg', '-o', 'out', '--page-size', 'Invalid'])).toThrow();
    expect(terminalText('\x1b[31mbad\x1b[0m\nnext\x00')).toBe('bad next ');
  });
  it.each([
    'LibreOffice 25.8.7',
    'LibreOffice 26.2.5',
    'LibreOffice 26.8.0',
    'LibreOfficeDev 27.2.0.0.alpha1',
  ])('rejects unsupported Office build %s', (version) =>
    expect(() => supportedOfficeVersion(version)).toThrow(),
  );
  it.each(['LibreOffice 26.2.6.2', 'LibreOffice 26.8.2.1', 'LibreOffice 27.2.0.1'])(
    'accepts stable Office build %s',
    (version) => expect(supportedOfficeVersion(version)).toMatch(/^2/),
  );
  it('bounds subprocess execution and handles cancellation', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }),
    ).rejects.toThrow('timed out');
    const controller = new AbortController();
    const result = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toThrow('cancelled');
  });
});
