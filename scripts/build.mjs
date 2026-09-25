#!/usr/bin/env node
/**
 * Build step.
 *
 * Runs via npm's `prepare` hook, which Cloudflare's build machine triggers
 * during install. That matters: Workers Builds does not honour the `build`
 * block in the Wrangler configuration file, so a repo-local hook is the only
 * way to run a build step without every forked deployment having to configure
 * a build command in the dashboard by hand.
 *
 * Two jobs:
 *   1. Generate the one-time setup code (printed here, hashed into the bundle).
 *   2. Compile each front-end tool: JSX through esbuild, Tailwind through its CLI.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { generateSetupCode } from './generate-setup-code.mjs';

const TOOLS = [
  {
    key: 'draft-helper',
    title: 'Draft Helper',
    entry: 'app/draft-helper/main.jsx',
    css: 'app/draft-helper/styles.css',
  },
  {
    key: 'live-matchups',
    title: 'Live Matchups',
    entry: 'app/live-matchups/main.jsx',
    css: 'app/live-matchups/styles.css',
  },
  {
    key: 'trade-analyzer',
    title: 'Trade Analyzer',
    entry: 'app/trade-analyzer/main.jsx',
    css: 'app/trade-analyzer/styles.css',
  },
  {
    key: 'hall-of-fame',
    title: 'Hall of Fame',
    entry: 'app/hall-of-fame/main.jsx',
    css: 'app/hall-of-fame/styles.css',
  },
  {
    key: 'fortune-teller',
    title: 'Fortune Teller',
    entry: 'app/fortune-teller/main.jsx',
    css: 'app/fortune-teller/styles.css',
    worker: 'app/fortune-teller/worker.js',
  },
  {
    key: 'llm-export',
    title: 'LLM Data Export',
    entry: 'app/llm-export/main.jsx',
    css: 'app/llm-export/styles.css',
  },
];

/**
 * The tool shell. Deliberately minimal and self-contained — no external fonts,
 * scripts or styles — so nothing loads before the Worker's auth gate has run.
 */
function shellHtml(tool) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${tool.title}</title>
<link rel="stylesheet" href="./styles.css">
<style>html,body{margin:0;background:#0A0D0B;}</style>
<script>
/* The palette is keyed off html[data-theme]. Setting it here rather than in a
   React effect means the first paint is already themed: an effect runs after
   paint, so the tool flashed with every colour variable unresolved. Light mode
   is honoured before any bundle loads. */
try{var m=document.cookie.match(/(?:^|; )eft_theme=([^;]*)/);
document.documentElement.dataset.theme=(m&&decodeURIComponent(m[1])==='light')?'light':'dark';
var r=document.cookie.match(/(?:^|; )eft_motion=([^;]*)/);
if(r&&decodeURIComponent(r[1])==='reduce')document.documentElement.classList.add('stillness');}catch(e){}
</script>
</head>
<body>
<div id="root"></div>
<script src="./bundle.js" defer></script>
</body>
</html>
`;
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

generateSetupCode();

for (const tool of TOOLS) {
  const outDir = `public/apps/${tool.key}`;
  mkdirSync(outDir, { recursive: true });

  console.log(`\nBuilding ${tool.key}…`);
  run('npx', [
    'esbuild', tool.entry,
    '--bundle',
    '--format=iife',
    '--target=es2020',
    '--jsx=automatic',
    '--minify',
    '--loader:.js=jsx',
    `--outfile=${outDir}/bundle.js`,
    '--log-level=warning',
  ]);

  if (tool.worker && existsSync(tool.worker)) {
    run('npx', ['esbuild', tool.worker, '--bundle', '--format=iife', '--target=es2020', '--minify', `--outfile=${outDir}/worker.js`, '--log-level=warning']);
  }

  if (existsSync(tool.css)) {
    run('npx', [
      '@tailwindcss/cli',
      '-i', tool.css,
      '-o', `${outDir}/styles.css`,
      '--minify',
    ]);
  }
  writeFileSync(`${outDir}/index.html`, shellHtml(tool));
  console.log(`  -> ${outDir}/bundle.js, styles.css, index.html`);
}

console.log('\nBuild complete.\n');
