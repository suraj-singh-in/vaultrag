// @ts-check
const esbuild = require('esbuild');
const builtins = require('builtin-modules');

const prod = process.argv[2] === 'production';

/** All modules that must NOT be bundled — provided by Obsidian at runtime. */
const OBSIDIAN_EXTERNALS = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
];

async function build() {
  const ctx = await esbuild.context({
    entryPoints: ['src/main.ts'],
    bundle: true,
    external: [...OBSIDIAN_EXTERNALS, ...builtins],
    format: 'cjs',
    target: 'es2018',
    logLevel: 'info',
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    outfile: 'main.js',
  });

  if (prod) {
    await ctx.rebuild();
    await ctx.dispose();
    process.exit(0);
  } else {
    await ctx.watch();
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
