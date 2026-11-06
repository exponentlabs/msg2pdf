export const LIMITS = Object.freeze({
  inputBytes: 100 * 1024 * 1024,
  bodyBytes: 10 * 1024 * 1024,
  attachmentBytes: 64 * 1024 * 1024,
  totalAttachmentBytes: 128 * 1024 * 1024,
  pdfBytes: 256 * 1024 * 1024,
  parseTimeoutMs: 30_000,
  renderTimeoutMs: 60_000,
  officeTimeoutMs: 120_000,
  workerMemoryMb: 512,
  maximumFiles: 100_000,
});
