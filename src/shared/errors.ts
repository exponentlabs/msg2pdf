export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export class CancelledError extends Error {
  constructor() {
    super('Conversion cancelled');
    this.name = 'CancelledError';
  }
}
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
