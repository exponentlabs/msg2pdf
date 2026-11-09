const { resolve } = require('node:path');
module.exports = {
  appId: 'com.exponentlabs.msg2pdf.b1',
  productName: 'msg2pdf-b1',
  executableName: 'msg2pdf-b1',
  directories: { output: resolve('artifacts/b1/package'), buildResources: resolve('build') },
  files: ['**/*', '!node_modules/**'],
  extraMetadata: { dependencies: {}, devDependencies: {} },
  asar: true,
  asarUnpack: ['lock.node'],
  npmRebuild: false,
  linux: { target: ['dir'], category: 'Development' },
  publish: null,
  electronFuses: {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
};
