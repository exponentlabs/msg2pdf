import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { validateSigningEnvironment } = createRequire(import.meta.url)(
  '../../scripts/signing.cjs',
) as {
  validateSigningEnvironment: (platform: string, env: Record<string, string>) => void;
};

describe('release signing prerequisites', () => {
  it('rejects missing macOS identity and ad-hoc identities', () => {
    expect(() => validateSigningEnvironment('darwin', {})).toThrow('Developer ID');
    expect(() => validateSigningEnvironment('darwin', { CSC_NAME: '-' })).toThrow('Developer ID');
  });

  it('requires notarisation credentials even with a signing identity', () => {
    expect(() => validateSigningEnvironment('darwin', { CSC_LINK: 'certificate' })).toThrow(
      'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID',
    );
  });

  it('accepts a configured macOS signing and notarisation environment', () => {
    expect(() =>
      validateSigningEnvironment('darwin', {
        CSC_LINK: 'certificate',
        APPLE_ID: 'developer@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: 'test-only',
        APPLE_TEAM_ID: 'test-team',
      }),
    ).not.toThrow();
  });

  it('rejects unsigned Windows release builds', () => {
    expect(() => validateSigningEnvironment('win32', {})).toThrow('WIN_CSC_LINK');
    expect(() => validateSigningEnvironment('win32', { WIN_SIGNING_PROVIDER: 'unknown' })).toThrow(
      'azure or certificate',
    );
  });

  it('requires a complete Azure configuration and an HTTPS endpoint', () => {
    expect(() => validateSigningEnvironment('win32', { WIN_SIGNING_PROVIDER: 'azure' })).toThrow(
      'AZURE_SIGNING_ENDPOINT',
    );
    const azure = {
      WIN_SIGNING_PROVIDER: 'azure',
      AZURE_SIGNING_ENDPOINT: 'https://example.test',
      AZURE_SIGNING_ACCOUNT_NAME: 'test-account',
      AZURE_SIGNING_CERTIFICATE_PROFILE_NAME: 'test-profile',
      WIN_PUBLISHER_NAME: 'Test Publisher',
      AZURE_TENANT_ID: 'test-tenant',
      AZURE_CLIENT_ID: 'test-client',
      AZURE_CLIENT_SECRET: 'test-only',
    };
    expect(() => validateSigningEnvironment('win32', azure)).not.toThrow();
    expect(() =>
      validateSigningEnvironment('win32', {
        ...azure,
        AZURE_SIGNING_ENDPOINT: 'http://example.test',
      }),
    ).toThrow('HTTPS');
  });

  it('accepts configured Windows certificate signing', () => {
    expect(() =>
      validateSigningEnvironment('win32', {
        WIN_CSC_LINK: 'certificate',
        WIN_CSC_KEY_PASSWORD: 'test-only',
      }),
    ).not.toThrow();
  });

  it('permits Linux packaging and rejects unsupported systems', () => {
    expect(() => validateSigningEnvironment('linux', {})).not.toThrow();
    expect(() => validateSigningEnvironment('freebsd', {})).toThrow('Unsupported');
  });
});
