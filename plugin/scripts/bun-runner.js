#!/usr/bin/env node
import { spawnSync, spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const IS_WINDOWS = process.platform === 'win32';

const __bun_runner_dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVED_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__bun_runner_dirname, '..');

function fixBrokenScriptPath(argPath) {
  if (argPath.startsWith('/scripts/') && !existsSync(argPath)) {
    const fixedPath = join(RESOLVED_PLUGIN_ROOT, argPath);
    if (existsSync(fixedPath)) {
      return fixedPath;
    }
  }
  return argPath;
}

function findBun() {
  const pathCheck = IS_WINDOWS
    ? spawnSync('where bun', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      })
    : spawnSync('which', ['bun'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    if (IS_WINDOWS) {
      const bunCmdPath = pathCheck.stdout.split('\n').find(line => line.trim().endsWith('bun.cmd'));
      if (bunCmdPath) {
        return bunCmdPath.trim();
      }
    }
    return 'bun'; 
  }

  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun'
      ];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      return bunPath;
    }
  }

  return null;
}

function isPluginDisabledInClaudeSettings() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.enabledPlugins?.['claude-mem@thedotmack'] === false;
  } catch {
    return false;
  }
}

if (isPluginDisabledInClaudeSettings()) {
  process.exit(0);
}

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node bun-runner.js <script> [args...]');
  process.exit(1);
}

args[0] = fixBrokenScriptPath(args[0]);

const bunPath = findBun();

if (!bunPath) {
  console.error('Error: Bun not found. Please install Bun: https://bun.sh');
  console.error('After installation, restart your terminal.');
  process.exit(1);
}

// Runtime self-heal: ensure the worker's externalized deps are present in
// plugin/node_modules before we spawn it. The build-time install + tarball
// bundling (build-hooks.js + package.json `files`) covers the npm channel,
// but the MARKETPLACE channel is a `git clone` of this repo where
// `plugin/node_modules` is gitignored and never committed — so a freshly
// installed marketplace plugin has no node_modules and every hook crashes
// with `Cannot find module 'zod/v3'` (issues #2407 / #2453 / #2640 / #2379).
// We can't fix that at build time (the install output is gitignored), so we
// heal once here, on first run, before the worker is invoked.
function ensureRuntimeDeps() {
  let pkgJsonPath;
  try {
    pkgJsonPath = join(RESOLVED_PLUGIN_ROOT, 'package.json');
    if (!existsSync(pkgJsonPath)) return; // not a plugin root with deps
    const pluginRequire = createRequire(pkgJsonPath);
    pluginRequire.resolve('zod/v3'); // resolves → deps present, nothing to do
    return;
  } catch {
    // zod/v3 unresolvable → install the hook-critical deps once.
    // We install ONLY zod + shell-quote (the pure-JS externals the worker
    // needs to boot), with --ignore-scripts. Rationale: npm resolves the full
    // dep tree from the existing package.json, and the tree-sitter grammars
    // are native node-gyp builds — on a Node version without a prebuilt
    // binding (e.g. Node 26) a grammar build fails and aborts the whole
    // install, leaving zod uninstalled. --ignore-scripts skips those native
    // postinstalls (zod/shell-quote are pure JS and need none), so the hook
    // always recovers. Grammar/code-graph deps heal separately via the full
    // `npx claude-mem install` and are not required for hooks to run.
    console.error('[bun-runner] plugin/node_modules missing zod — installing hook-critical deps (first run on this install)...');
    const install = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', 'zod@^4.3.6', 'shell-quote@^1.8.3'], {
      cwd: RESOLVED_PLUGIN_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      // npm on Windows is a .cmd shim — spawn without shell hits ENOENT.
      shell: IS_WINDOWS,
    });
    if (install.error) {
      console.error(`[bun-runner] could not run npm install in ${RESOLVED_PLUGIN_ROOT}: ${install.error.message}`);
    } else if (install.status === 0) {
      console.error('[bun-runner] runtime deps installed.');
    } else {
      console.error(`[bun-runner] npm install exited with code ${install.status}. Run \`cd ${RESOLVED_PLUGIN_ROOT} && npm install\` manually.`);
    }
  }
}

ensureRuntimeDeps();

function collectStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
    process.stdin.on('error', () => {
      resolve(null);
    });

    setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    }, 5000);
  });
}

const stdinData = await collectStdin();

const spawnOptions = {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env
};

let spawnCmd = bunPath;
let spawnArgs = args;

if (IS_WINDOWS) {
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  spawnOptions.shell = true;
  spawnCmd = [bunPath, ...args].map(quote).join(' ');
  spawnArgs = [];
}

const child = spawn(spawnCmd, spawnArgs, spawnOptions);

if (child.stdin) {
  if (stdinData && stdinData.length > 0) {
    child.stdin.write(stdinData);
    child.stdin.end();
  } else {
    // Issue #2188: empty/missing stdin previously masked by `|| '{}'` fallback,
    // which silently hid WSL bash failures (e.g. hooks invoked under a broken
    // shell that never piped a payload). Surface the failure mode instead.
    const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
    const payloadType = stdinData === null
      ? 'null (no data event or stream error)'
      : stdinData === undefined
        ? 'undefined'
        : Buffer.isBuffer(stdinData) && stdinData.length === 0
          ? 'empty Buffer (zero bytes received)'
          : `unexpected (${typeof stdinData})`;
    const payloadByteLength = (stdinData && typeof stdinData.length === 'number')
      ? stdinData.length
      : 0;
    const diagnostic = [
      `[bun-runner] empty stdin payload received — issue #2188`,
      `  script: ${args[0]}`,
      `  payload byte length: ${payloadByteLength}`,
      `  payload type: ${payloadType}`,
      `  platform: ${process.platform}`,
      `  shell: ${process.env.SHELL || 'n/a'}`,
      `  stdin TTY: ${process.stdin.isTTY === true ? 'true' : process.stdin.isTTY === false ? 'false' : 'undefined'}`,
      `  timestamp: ${new Date().toISOString()}`,
      `  CLAUDE_PLUGIN_ROOT: ${RESOLVED_PLUGIN_ROOT}`,
    ].join('\n');

    // Write to stderr so Claude Code surfaces the diagnostic.
    console.error(diagnostic);

    // Persist diagnostic to the runner-errors log and drop a CAPTURE_BROKEN marker
    // file so the next session-start hint can surface the failure. We exit 0 to
    // honor the project's exit-code strategy (worker/hook errors exit 0 to
    // prevent Windows Terminal tab pileup) — the marker file is the durable
    // signal that something is wrong, not the exit code.
    try {
      const logsDir = join(dataDir, 'logs');
      mkdirSync(logsDir, { recursive: true });
      appendFileSync(join(logsDir, 'runner-errors.log'), diagnostic + '\n\n');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'CAPTURE_BROKEN'), diagnostic + '\n');
    } catch (writeErr) {
      console.error(`[bun-runner] failed to persist diagnostic: ${writeErr && writeErr.message ? writeErr.message : writeErr}`);
    }

    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
    process.exit(0);
  }
}

child.on('error', (err) => {
  console.error(`Failed to start Bun: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if ((signal || code > 128) && args.includes('start')) {
    process.exit(0);
  }
  process.exit(code || 0);
});
