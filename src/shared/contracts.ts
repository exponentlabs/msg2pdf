import { z } from 'zod';

export const optionsSchema = z.object({
  recursive: z.boolean().default(false),
  extractAttachments: z.boolean().default(false),
  allToPdf: z.boolean().default(false),
  overwrite: z.boolean().default(false),
  pageSize: z.enum(['A4', 'Letter']).default('A4'),
});
export type ConversionOptions = z.infer<typeof optionsSchema>;
export const requestSchema = z.object({
  inputs: z.array(z.string().min(1).max(32_768)).min(1).max(1_000),
  output: z.string().min(1).max(32_768),
  options: optionsSchema,
});
export type ConversionRequest = z.infer<typeof requestSchema>;
export type FileKind = 'email' | 'office' | 'pdf' | 'unsupported';
export type FileStatus =
  | 'queued'
  | 'working'
  | 'converted'
  | 'copied'
  | 'skipped'
  | 'failed'
  | 'partial'
  | 'cancelled';
export interface PlannedFile {
  id: string;
  source: string;
  destination: string;
  name: string;
  relativeName: string;
  size: number;
  kind: FileKind;
}
export interface PlanIssue {
  path: string;
  message: string;
}
export interface ConversionPlan {
  id: string;
  output: string;
  files: PlannedFile[];
  issues: PlanIssue[];
  options: ConversionOptions;
  totalBytes: number;
}
export interface FileResult extends PlannedFile {
  status: Exclude<FileStatus, 'queued' | 'working'>;
  error?: string;
  attachments: number;
  durationMs: number;
}
export interface BatchSummary {
  id: string;
  startedAt: string;
  finishedAt: string;
  output: string;
  processed: number;
  converted: number;
  copied: number;
  skipped: number;
  unsupported: number;
  failed: number;
  attachments: number;
  cancelled: boolean;
  issues: PlanIssue[];
  results: FileResult[];
}
export type ConversionEvent =
  | { type: 'plan'; plan: ConversionPlan }
  | { type: 'file-start'; id: string }
  | { type: 'file-complete'; result: FileResult }
  | { type: 'complete'; summary: BatchSummary };
export interface InputSelection {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
}
export interface OutputSelection {
  id: string;
  path: string;
}
export interface OfficeStatus {
  available: boolean;
  executable: string | null;
  version: string | null;
  source: 'detected' | 'configured' | 'missing';
  error: string | null;
}
export interface AppInfo {
  version: string;
  platform: string;
  office: OfficeStatus;
}
export interface EmailPreview {
  subject: string;
  sender: string;
  recipients: string;
  sentAt: string;
  html: string;
  attachmentCount: number;
}
export interface GuiRequest {
  inputIds: string[];
  outputId: string;
  options: ConversionOptions;
}
export const guiRequestSchema = z.object({
  inputIds: z.array(z.string().uuid()).min(1).max(1_000),
  outputId: z.string().uuid(),
  options: optionsSchema,
});
export interface DesktopApi {
  info(): Promise<AppInfo>;
  chooseInputs(kind: 'files' | 'directory'): Promise<InputSelection[]>;
  importDroppedFiles(files: File[]): Promise<InputSelection[]>;
  chooseOutput(): Promise<OutputSelection | null>;
  plan(request: GuiRequest): Promise<ConversionPlan>;
  convert(request: GuiRequest): Promise<void>;
  cancel(): Promise<void>;
  preview(inputId: string): Promise<EmailPreview>;
  revealOutput(): Promise<void>;
  openResult(resultId: string): Promise<void>;
  exportReport(): Promise<boolean>;
  history(): Promise<BatchSummary[]>;
  clearHistory(): Promise<void>;
  chooseOffice(): Promise<OfficeStatus>;
  detectOffice(): Promise<OfficeStatus>;
  downloadOffice(): Promise<void>;
  onProgress(listener: (event: ConversionEvent) => void): () => void;
}
