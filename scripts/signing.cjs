function validateSigningEnvironment(platform, env) {
  const requireVariables = (names) => {
    const missing = names.filter((name) => !env[name]?.trim());
    if (missing.length) throw new Error(`Release signing requires: ${missing.join(', ')}`);
  };
  if (platform === 'darwin') {
    if ((!env.CSC_LINK && !env.CSC_NAME) || env.CSC_NAME === '-')
      throw new Error('macOS releases require a Developer ID identity (CSC_LINK or CSC_NAME).');
    requireVariables(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']);
  } else if (platform === 'win32') {
    if (env.WIN_SIGNING_PROVIDER === 'azure') {
      requireVariables([
        'AZURE_SIGNING_ENDPOINT',
        'AZURE_SIGNING_ACCOUNT_NAME',
        'AZURE_SIGNING_CERTIFICATE_PROFILE_NAME',
        'WIN_PUBLISHER_NAME',
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
      ]);
      if (new URL(env.AZURE_SIGNING_ENDPOINT).protocol !== 'https:')
        throw new Error('Azure signing requires an HTTPS endpoint.');
    } else if (!env.WIN_SIGNING_PROVIDER || env.WIN_SIGNING_PROVIDER === 'certificate') {
      requireVariables(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']);
    } else throw new Error('WIN_SIGNING_PROVIDER must be azure or certificate.');
  } else if (platform !== 'linux') throw new Error(`Unsupported release platform: ${platform}`);
}

module.exports = { validateSigningEnvironment };
