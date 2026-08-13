/**
 * Stage manul-browser into `resources/`.
 *
 * Two halves, both from the sibling checkout rather than npm — the
 * `manul-browser` package publishes no platform packages yet, so there is
 * nowhere else for either to come from:
 *
 *   resources/bin/manul.exe        the Go engine, built here
 *   resources/manul-browser/       the Node binding's compiled dist, copied
 *
 * Staging both under `resources/` is what makes packaging possible: a shipped
 * `.exe` cannot reach a checkout on the build machine, and electron-builder can
 * only copy from a path it knows in advance.
 *
 * Run as `--optional` (from postinstall) it reports and exits 0 when Go or the
 * checkout is missing: a fresh clone should still install.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSearch, findBindingEntry, findCheckout, findEngineSource } from '../src/shared/engine.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const optional = process.argv.includes('--optional');

/** The engine binary keeps manul-browser's own CLI name — the binding expects it. */
export const binaryName = process.platform === 'win32' ? 'manul.exe' : 'manul';
export const binaryPath = join(root, 'resources', 'bin', binaryName);
export const bindingDir = join(root, 'resources', 'manul-browser');

function fail(message) {
  if (optional) {
    console.warn(`[manul-browser] skipped: ${message}`);
    console.warn('[manul-browser] browser control stays offline until you run `npm run engine`.');
    process.exit(0);
  }
  console.error(`[manul-browser] ${message}`);
  process.exit(1);
}

/** Build the Go engine into `resources/bin`. */
function buildEngine(source) {
  mkdirSync(dirname(binaryPath), { recursive: true });
  console.log(`[manul-browser] building ${source} -> ${binaryPath}`);

  const build = spawnSync('go', ['build', '-o', binaryPath, './cmd/manul'], {
    cwd: source,
    stdio: 'inherit',
  });
  if (build.status !== 0) fail('go build failed.');
}

/**
 * Copy the binding's compiled `dist/` in.
 *
 * `dist` ships compiled in the checkout, so there is no `tsc` to run — building
 * inside someone else's repository during our install would be rude anyway.
 */
function stageBinding() {
  const entry = findBindingEntry(root);
  if (!entry) {
    console.warn('[manul-browser] binding dist not found — run `npm run build` in the checkout to package it.');
    return;
  }
  const source = dirname(entry);
  rmSync(bindingDir, { recursive: true, force: true });
  cpSync(source, bindingDir, { recursive: true });

  // manul-browser is Apache 2.0 and we redistribute both halves of it inside
  // the packaged app, so its licence travels with them.
  const checkout = findCheckout(root);
  for (const candidate of [join(checkout, 'bindings', 'node', 'LICENSE'), join(checkout, 'LICENSE')]) {
    if (existsSync(candidate)) {
      cpSync(candidate, join(bindingDir, 'LICENSE'));
      break;
    }
  }

  console.log(`[manul-browser] staged binding ${source} -> ${bindingDir}`);
}

function main() {
  const source = findEngineSource(root);
  if (!source) {
    fail(
      `no checkout found (tried ${describeSearch()}) — clone ` +
        'https://github.com/alexbeatnik/manul-browser beside this repo, or set MANUL_SOURCE.',
    );
  }

  // The binding is copied even when Go is missing: chat works without the
  // engine, and staging what we can costs nothing.
  stageBinding();

  if (spawnSync('go', ['version']).status !== 0) {
    fail('Go toolchain not found on PATH (needs Go >= 1.26).');
  }
  buildEngine(source);

  console.log(`[manul-browser] ok${existsSync(binaryPath) ? '' : ' (engine missing)'}`);
}

main();
