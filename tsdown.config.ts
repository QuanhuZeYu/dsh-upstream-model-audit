/** 仓库外 dsh 插件的独立构建：host 半 ESM + browser 半 CJS bundle + 便于 node --test 的纯模块。 */
import { defineConfig } from 'tsdown'

const ID = 'dsh-upstream-model-audit'

/** shell 已提供的模块（其余一律内联进 bundle）。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

const isPlatformModule = (specifier: string): boolean => PLATFORM_MODULES.includes(specifier)

export default defineConfig([
  {
    name: ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: (specifier) => specifier === '@deepseek-ai/cordis' },
  },
  {
    name: ID + '/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: { neverBundle: isPlatformModule, alwaysBundle: (specifier) => !isPlatformModule(specifier) },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.MODE': '"production"',
      'import.meta.env': '{"MODE":"production"}',
    },
    outputOptions: {
      entryFileNames: 'client.js',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      banner: (chunk) => 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID)
        + ', ' + (chunk.isEntry ? '' : 'chunk: ' + JSON.stringify(chunk.fileName) + ', ')
        + 'factory: (require) => {',
      footer: 'return module.exports; } });',
    },
  },
  {
    // 仅供 node --test 使用：纯逻辑模块的普通 ESM 产物（不计入 files）。
    name: ID + '/dev',
    entry: { marks: 'src/marks.ts', observe: 'src/observe.ts', host: 'src/host.ts' },
    outDir: 'lib/dev',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
