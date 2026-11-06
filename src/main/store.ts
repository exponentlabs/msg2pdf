import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isMissing } from '../core/filesystem';
import type { BatchSummary } from '../shared/contracts';

const pathSchema = z.string().max(32_768);
const numberSchema = z.number().nonnegative();
const resultSchema = z.object({
  id: z.string(),
  source: pathSchema,
  destination: pathSchema,
  name: z.string(),
  relativeName: pathSchema,
  size: numberSchema,
  kind: z.enum(['email', 'office', 'pdf', 'unsupported']),
  status: z.enum(['converted', 'copied', 'skipped', 'failed', 'partial', 'cancelled']),
  error: z.string().max(8192).optional(),
  attachments: numberSchema,
  durationMs: numberSchema,
});
const summarySchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  output: pathSchema,
  processed: numberSchema,
  converted: numberSchema,
  copied: numberSchema,
  skipped: numberSchema,
  unsupported: numberSchema,
  failed: numberSchema,
  attachments: numberSchema,
  cancelled: z.boolean(),
  issues: z.array(z.object({ path: pathSchema, message: z.string() })).max(100),
  results: z.array(resultSchema).max(500),
});
const preferencesSchema = z.object({ officePath: z.string().max(32_768).optional() });
export class AppStore {
  constructor(private readonly directory: string) {}
  private async read(name: string): Promise<unknown> {
    const path = join(this.directory, name);
    try {
      if ((await stat(path)).size > 16 * 1024 * 1024)
        throw new Error('Settings file exceeds size limit');
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  private async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.directory, name));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async officePath(): Promise<string | undefined> {
    const parsed = preferencesSchema.safeParse(await this.read('preferences.json'));
    return parsed.success ? parsed.data.officePath : undefined;
  }
  async setOfficePath(officePath: string): Promise<void> {
    await this.write('preferences.json', { officePath });
  }
  async history(): Promise<BatchSummary[]> {
    const result = z
      .array(summarySchema)
      .max(20)
      .safeParse(await this.read('history.json'));
    if (!result.success) return [];
    return result.data.map((summary) => ({
      ...summary,
      results: summary.results.map(({ error, ...file }) => (error ? { ...file, error } : file)),
    }));
  }
  async record(summary: BatchSummary): Promise<void> {
    const history = await this.history();
    await this.write(
      'history.json',
      [
        {
          ...summary,
          results: summary.results.slice(0, 500),
          issues: summary.issues.slice(0, 100),
        },
        ...history,
      ].slice(0, 20),
    );
  }
  async clearHistory(): Promise<void> {
    await this.write('history.json', []);
  }
}
