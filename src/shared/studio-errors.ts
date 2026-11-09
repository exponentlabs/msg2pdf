/** Preserve native/domain error codes across Electron's message-only error serialization. */
export function studioFailure(error: unknown): { code: string; message: string } {
  if (!(error instanceof Error))
    return { code: 'STUDIO_OPERATION_FAILED', message: 'The studio operation failed.' };
  if (error.name === 'ZodError')
    return { code: 'INVALID_STUDIO_ARGUMENTS', message: 'Invalid studio command or case data.' };
  const native = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const code = /^(CASE_[A-Z_]+|RELEASE_[A-Z_]+|STATE_STALE)$/.test(native)
    ? native
    : /^[A-Z][A-Z0-9_]{2,60}$/.test(error.message)
      ? error.message
      : error.message.startsWith('Usage:')
        ? 'INVALID_STUDIO_ARGUMENTS'
        : 'STUDIO_OPERATION_FAILED';
  const messages: Record<string, string> = {
    CASE_BUSY: 'The case is already open or another operation is running.',
    CASE_LOCK_UNAVAILABLE: 'The case lock could not be acquired safely.',
    STATE_STALE: 'The case changed. Refresh and retry the operation.',
    FAMILY_UNRESOLVED: 'Resolve every selected family member before release.',
    CASE_POLICY_STALE:
      'This earlier development case is read-only. Back it up and capture its originals in a new case; reviews and inventories cannot be migrated automatically.',
  };
  return { code, message: `${code}: ${messages[code] ?? error.message.slice(0, 1000)}` };
}
