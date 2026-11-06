import { basename, dirname, extname, join } from 'node:path';
import type {
  BatchSummary,
  ConversionEvent,
  ConversionPlan,
  FileResult,
  PlannedFile,
} from '../shared/contracts';
import { CancelledError, errorMessage, throwIfCancelled } from '../shared/errors';
import type { NormalizedEmail } from './email';
import { atomicCopy, atomicWrite, inspectOutput, shouldWrite } from './filesystem';
import { OFFICE_EXTENSIONS } from './formats';
import { buildEmailHtml } from './html';
import { LIMITS } from './limits';
import { lockOutput } from './lock';
import { attachmentLeaf, NameAllocator } from './names';
import { outputAllocators } from './planner';

export interface ConversionServices {
  parseEmail(path: string, signal?: AbortSignal): Promise<NormalizedEmail>;
  renderPdf(html: string, pageSize: 'A4' | 'Letter', signal?: AbortSignal): Promise<Uint8Array>;
  convertOffice(
    source: string,
    destination: string,
    root: string,
    overwrite: boolean,
    signal?: AbortSignal,
  ): Promise<boolean>;
}
export async function runConversion(
  plan: ConversionPlan,
  services: ConversionServices,
  emit: (event: ConversionEvent) => void,
  signal?: AbortSignal,
): Promise<BatchSummary> {
  throwIfCancelled(signal);
  const release = await lockOutput(plan.output);
  try {
    return await runLockedConversion(plan, services, emit, signal);
  } finally {
    await release();
  }
}
async function runLockedConversion(
  plan: ConversionPlan,
  services: ConversionServices,
  emit: (event: ConversionEvent) => void,
  signal?: AbortSignal,
): Promise<BatchSummary> {
  const startedAt = new Date().toISOString();
  const results: FileResult[] = [];
  const allocators = outputAllocators(plan);
  let cancelled = false;
  emit({ type: 'plan', plan });
  for (const file of plan.files) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const start = performance.now();
    emit({ type: 'file-start', id: file.id });
    let status: FileResult['status'] = 'skipped';
    let attachments = 0;
    let error: string | undefined;
    try {
      if (file.kind !== 'unsupported' && file.size > LIMITS.inputBytes)
        throw new Error('Input exceeds the 100 MiB limit');
      if (file.kind === 'pdf')
        status = (await atomicCopy(
          file.source,
          file.destination,
          plan.output,
          plan.options.overwrite,
        ))
          ? 'copied'
          : 'skipped';
      else if (file.kind === 'office')
        status = (await services.convertOffice(
          file.source,
          file.destination,
          plan.output,
          plan.options.overwrite,
          signal,
        ))
          ? 'converted'
          : 'skipped';
      else if (file.kind === 'email') {
        const writePdf = await shouldWrite(file.destination, plan.output, plan.options.overwrite);
        if (writePdf || plan.options.extractAttachments) {
          const message = await services.parseEmail(file.source, signal);
          throwIfCancelled(signal);
          // Preserve the primary document even if an individual attachment is
          // unreadable or needs an optional Office installation.
          if (writePdf) {
            const pdf = await services.renderPdf(
              buildEmailHtml(message, plan.options.pageSize),
              plan.options.pageSize,
              signal,
            );
            throwIfCancelled(signal);
            if (await atomicWrite(file.destination, plan.output, pdf, plan.options.overwrite))
              status = 'converted';
          }
          if (plan.options.extractAttachments) {
            const parent = dirname(file.destination);
            const allocator =
              allocators.get(parent) ?? new NameAllocator([basename(file.destination)]);
            allocators.set(parent, allocator);
            const ordinary = message.attachments.filter(
              (attachment) => !attachment.hidden && !attachment.inline,
            );
            const sourceNames = ordinary.map(
              (attachment, index) =>
                `${basename(file.destination, extname(file.destination))} - ${attachmentLeaf(attachment.name, index)}`,
            );
            // Reserve ordinary PDF attachment names before allocating converted
            // Office attachments, preserving both report.pdf and report.docx.
            const allocated = allocateAttachmentNames(
              sourceNames,
              plan.options.allToPdf,
              allocator,
            );
            const failures: string[] = [];
            for (const [index, attachment] of ordinary.entries()) {
              throwIfCancelled(signal);
              try {
                const name = allocated[index];
                const sourceName = sourceNames[index];
                if (!name || !sourceName) throw new Error('Missing attachment destination');
                const destination = join(parent, name);
                if (!(await shouldWrite(destination, plan.output, plan.options.overwrite)))
                  continue;
                if (!attachment.data)
                  throw new Error(
                    `Attachment contains an unsupported external reference: ${attachment.name}`,
                  );
                if (attachment.data.byteLength > LIMITS.attachmentBytes)
                  throw new Error('Attachment exceeds the 64 MiB limit');
                if (
                  plan.options.allToPdf &&
                  OFFICE_EXTENSIONS.has(extname(sourceName).toLowerCase())
                ) {
                  if (
                    await saveOfficeAttachment(
                      file,
                      attachment.data,
                      extname(sourceName),
                      destination,
                      plan,
                      services,
                      signal,
                    )
                  )
                    attachments++;
                } else if (
                  await atomicWrite(
                    destination,
                    plan.output,
                    attachment.data,
                    plan.options.overwrite,
                  )
                )
                  attachments++;
              } catch (caught) {
                if (signal?.aborted || caught instanceof CancelledError) throw caught;
                failures.push(`${attachment.name}: ${errorMessage(caught)}`);
              }
            }
            if (failures.length) {
              error = failures.join('\n').slice(0, 8192);
              status = status === 'converted' ? 'partial' : 'failed';
            }
          }
        }
      }
    } catch (caught) {
      if (caught instanceof CancelledError || signal?.aborted) {
        cancelled = true;
        status = 'cancelled';
      } else {
        status = 'failed';
        error = errorMessage(caught);
      }
    }
    const result: FileResult = {
      ...file,
      status,
      attachments,
      durationMs: Math.round(performance.now() - start),
      ...(error ? { error } : {}),
    };
    results.push(result);
    emit({ type: 'file-complete', result });
    if (cancelled) break;
  }
  const summary: BatchSummary = {
    id: plan.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    output: plan.output,
    processed: results.length,
    converted: results.filter(
      (result) => result.status === 'converted' || result.status === 'partial',
    ).length,
    copied: results.filter((result) => result.status === 'copied').length,
    skipped: results.filter(
      (result) => result.status === 'skipped' && result.kind !== 'unsupported',
    ).length,
    unsupported: results.filter((result) => result.kind === 'unsupported').length,
    failed:
      plan.issues.length +
      results.filter((result) => result.status === 'failed' || result.status === 'partial').length,
    attachments: results.reduce((sum, result) => sum + result.attachments, 0),
    cancelled,
    issues: plan.issues,
    results,
  };
  emit({ type: 'complete', summary });
  return summary;
}
function allocateAttachmentNames(
  names: string[],
  convertOffice: boolean,
  allocator: NameAllocator,
): string[] {
  const converting = names.map(
    (name) => convertOffice && OFFICE_EXTENSIONS.has(extname(name).toLowerCase()),
  );
  const targets = names.map((name, index) =>
    converting[index] ? `${name.slice(0, -extname(name).length)}.pdf` : name,
  );
  const counts = new Map<string, number>();
  for (const name of targets)
    counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  const result = new Map<number, string>();
  for (const [index, name] of names.entries())
    if (!converting[index]) result.set(index, allocator.allocate(name));
  for (const [index, name] of names.entries()) {
    if (!converting[index]) continue;
    const target = targets[index];
    if (!target) throw new Error('Missing attachment name');
    result.set(
      index,
      allocator.allocate((counts.get(target.toLowerCase()) ?? 0) > 1 ? `${name}.pdf` : target),
    );
  }
  return names.map((_, index) => {
    const name = result.get(index);
    if (!name) throw new Error('Missing attachment allocation');
    return name;
  });
}
async function saveOfficeAttachment(
  file: PlannedFile,
  data: Uint8Array,
  extension: string,
  destination: string,
  plan: ConversionPlan,
  services: ConversionServices,
  signal?: AbortSignal,
): Promise<boolean> {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  // The original attachment is staged privately and removed after conversion.
  await inspectOutput(destination, plan.output, true);
  const scratch = await mkdtemp(join(dirname(file.destination), '.attachment-'));
  try {
    const source = join(scratch, `attachment${extension}`);
    await writeFile(source, data, { mode: 0o600 });
    return await services.convertOffice(
      source,
      destination,
      plan.output,
      plan.options.overwrite,
      signal,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
