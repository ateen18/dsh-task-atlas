import { defineConfig } from 'tsdown'

/**
 * The browser artifact is NOT an ES module: DSH loads `lib/client.js` as a
 * classic `<script>`, and the file's only job is to REGISTER a lazy factory
 * on the page-global `window.__ModuleLoader__` facade:
 *
 *   window.__ModuleLoader__.load({ id: <package name>, factory: (require) => exports })
 *
 * The factory body must be CJS — every module body side effect (including CSS
 * injection) has to live inside the factory closure so it runs at
 * materialization, not at script execution. `require()` resolves against the
 * shell's frozen `PLATFORM_MODULES` table (React, Cordis, static UI libs);
 * anything else must be declared in `dsh.client.external`.
 *
 * Hence: format `cjs` for the client half, wrapped by banner/footer into the
 * registration shape. The host half stays ordinary ESM.
 */
const PKG = 'dsh-task-atlas'

/** External module requests resolved from the shell's platform module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

/**
 * Packages the client imports that the shell does NOT provide, so they must be
 * inlined into `lib/client.js`.
 *
 * tsdown externalises package.json `dependencies` by default; for a client plugin
 * that default is fatal, because the bundle's `require` is resolved against a frozen
 * platform table. `scripts/check-client-bundle.mjs` fails the build if anything slips
 * through this list.
 */
const CLIENT_BUNDLED: string[] = []

/**
 * Host-half externals.
 *
 * Everything here is supplied by the harness at runtime and must NOT be bundled:
 * a second copy of cordis would mean a second service registry, and a second zod
 * would mean schemas the host cannot recognise. Only this plugin's own source
 * belongs in `lib/index.js`.
 */
const HOST_EXTERNALS = [/^@deepseek-ai\//, /^node:/, 'zod', 'schemastery']

export default defineConfig([
  {
    // ---- host half: ESM, runs in the harness Node process -------------------
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    deps: { neverBundle: HOST_EXTERNALS },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  {
    // ---- client half: lazy CJS factory registered on __ModuleLoader__ ------
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    /**
     * `neverBundle` is the platform table; `alwaysBundle` overrides tsdown's default
     * of treating package.json `dependencies` as external.
     *
     * That default is what broke the app once: dagre is a real dependency, so it was
     * left as `require('@dagrejs/dagre')`, the shell's module table had no such entry,
     * and the whole client bootstrap failed — "1 entry did not activate". Anything the
     * client imports must be inlined here, no exceptions.
     */
    deps: {
      neverBundle: CLIENT_EXTERNALS,
      alwaysBundle: CLIENT_BUNDLED,
    },
    outExtensions: () => ({ js: '.js' }),
    banner: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(PKG)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
    ].join('\n'),
    footer: ['\t\treturn module.exports;', '\t}', '});'].join('\n'),
  },
])
