import { defineConfig } from 'tsdown'

/** Browser module-table specifiers the Web shell already provides. */
const CLIENT_EXTERNALS = [/^react(\/|$)/u]

export default defineConfig([
  {
    name: 'dsh-github-agents-proxy',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
    deps: {
      neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
    },
  },
  {
    name: '@dynastxu/dsh-github-agents-proxy/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: CLIENT_EXTERNALS,
      alwaysBundle: specifier => !CLIENT_EXTERNALS.some(pattern => pattern.test(specifier)),
    },
    inputOptions: { transform: { jsx: 'react-jsx' } },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@dynastxu/dsh-github-agents-proxy", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
