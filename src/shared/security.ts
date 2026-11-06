export function originKey(value: string): string {
  const url = new URL(value);
  return url.protocol === 'app:' ? `app://${url.hostname}` : url.origin;
}
