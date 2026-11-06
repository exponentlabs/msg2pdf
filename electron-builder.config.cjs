const { access, chmod, copyFile } = require('node:fs/promises');
const { join } = require('node:path');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.cambrian.msg2pdf',
  productName: 'msg2pdf',
  copyright: 'Copyright © 2026 Exponent Labs',
  executableName: 'msg2pdf',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these artifact macros.
  artifactName: 'msg2pdf-${version}-${os}-${arch}.${ext}',
  directories: { output: 'release', buildResources: 'build' },
  asar: true,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  files: ['out/**/*', 'package.json', '!node_modules/**'],
  extraMetadata: { dependencies: {}, devDependencies: {} },
  extraResources: [
    { from: 'resources/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' },
    { from: 'resources/third-party-notices.json', to: 'third-party-notices.json' },
    { from: 'README.md', to: 'README.md' },
    { from: 'SECURITY.md', to: 'SECURITY.md' },
    { from: 'CONTRIBUTING.md', to: 'CONTRIBUTING.md' },
    { from: 'docs', to: 'docs', filter: ['**/*.md'] },
  ],
  electronFuses: {
    // The bundled terminal launcher uses Electron's Node runtime, like VS Code.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: process.platform !== 'linux',
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    identity: process.env.CSC_NAME || (process.env.CSC_LINK ? undefined : '-'),
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    // A local ad-hoc signature has no Team ID. Hardened library validation is
    // enabled for credentialed release builds, where all binaries share one.
    hardenedRuntime: Boolean(process.env.CSC_NAME || process.env.CSC_LINK),
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  win: {
    target: ['nsis'],
    extraResources: [
      { from: 'resources/native/office-sandbox.exe', to: 'native/office-sandbox.exe' },
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
    synopsis: 'Private offline email-to-PDF workbench',
    description:
      'Convert MSG and EML messages locally, with optional LibreOffice document conversion.',
    maintainer: 'Exponent Labs',
  },
  deb: { depends: ['libgtk-3-0', 'libnss3', 'libxss1', 'libasound2', 'bubblewrap'] },
  publish: null,
  beforePack: async (context) => {
    if (context.electronPlatformName === 'win32')
      await access('resources/native/office-sandbox.exe');
  },
  afterPack: async (context) => {
    const platform = context.electronPlatformName;
    const resources =
      platform === 'darwin'
        ? join(context.appOutDir, 'msg2pdf.app', 'Contents', 'Resources')
        : join(context.appOutDir, 'resources');
    const { mkdir } = require('node:fs/promises');
    const bin = join(resources, 'bin');
    await mkdir(bin, { recursive: true });
    const name = platform === 'win32' ? 'msg2pdf.cmd' : 'msg2pdf';
    await copyFile(
      `resources/launchers/${platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : 'windows'}`,
      join(bin, name),
    );
    if (platform !== 'win32') await chmod(join(bin, name), 0o755);
  },
};
