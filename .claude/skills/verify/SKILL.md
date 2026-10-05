---
name: verify
description: Run, test, smoke-check or package Wasteland Next on Windows. Use whenever you need to start the app, run `npm test` or `npm run smoke`, read a smoke report, build the installer with electron-builder, or take a screenshot of the UI — this environment has several traps that make each of those fail silently or succeed while doing nothing.
---

# Running, checking and packaging Wasteland Next

Every command below has a way of *appearing* to work while doing nothing. Check
the artefact, never the exit code.

## Unit tests

```bash
npm test                        # or: node --test test/*.test.mjs
```

Both run fine straight from Git Bash. From PowerShell, `npm.ps1` can be blocked
by the default ExecutionPolicy (`PSSecurityException`), which reads as a broken
test script rather than a machine setting — use `node --test test/*.test.mjs`
there.

A known failure: `browser control loads into the real host, without a browser in
it` fails when `../wasteland-plugin-manul-browser` is checked out and its
manifest declares the `scene` service. It is skipped entirely when that checkout
is absent. Confirm against `git stash` before treating it as yours.

## Never use `cmd /c` from Git Bash

MSYS rewrites anything argument-shaped like a Unix path, so `/c` reaches `cmd`
as `C:/Program Files/Git/c`. `cmd` finds no command, opens interactively against
a null stdin, prints its banner and **exits 0**. `cmd /c "npm run dist"` returns
success, builds nothing, and leaves the previous artefacts in `dist/` looking
like the ones just made.

```bash
cmd //c "npm test"              # works — the double slash escapes the rewrite
MSYS_NO_PATHCONV=1 cmd /c ...   # also works
npm test                        # simplest: the shim is not needed at all
```

## Smoke test

```bash
unset ELECTRON_RUN_AS_NODE
SMOKE_REPORT=/path/to/report.txt npx electron scripts/smoke.mjs >/dev/null 2>&1
grep -E "FAIL|skip|^PASS" /path/to/report.txt
```

Electron on Windows has no attached console, so main-process `console.log` goes
nowhere when stdout is piped — **the report file is the only output**. The run
ends in `PASS` or `FAIL (n)`; a report that does not exist at all means the
script died before `whenReady`.

`ELECTRON_RUN_AS_NODE` is set by VS Code's integrated terminal. With it set,
`npx electron` runs as plain Node, `require('electron')` returns a path string,
and you get `Cannot read properties of undefined` from the ESM loader. Not an
app bug; no import change fixes it.

### When a smoke run produces no report at all

```bash
node --check scripts/smoke.mjs
```

Answers in a second. The usual cause is **a backtick inside one of the
`executeJavaScript(\`…\`)` template literals** — including inside a comment in
one. It ends the literal, throws `SyntaxError` at module load, so Electron never
reaches `whenReady`, the watchdog never arms, and `npm run smoke`
simply hangs. Never write backticks in those strings, comments included.

### Writing smoke checks

- Assert on `getComputedStyle(node).display`, never on `node.hidden`. The
  attribute is only the UA rule `[hidden] { display: none }`, and any
  author-level `display` outranks it — a check reading the attribute passes
  while the element sits visible on screen.
- For a `<details>`, assert its measured **height** against its summary's, not
  the `open` attribute. Content inside a closed details still returns client
  rects in Chromium, so rect-counting does not prove it is folded.
- Prove every new check bites: break the thing it guards, re-run, confirm it
  fails, restore. A threshold the bug also passes is not a check.
- The runner points `pluginRegistry` at a closed loopback port, so only two
  registries are asked and both fail in milliseconds. Keep it that way — a check
  that waits out a 20-second fetch timeout eventually kills the suite.
- Use `waitFor(window, expr)` rather than `setTimeout`. A fixed interval is
  either longer than it needs on every run or too short on the one run that
  mattered, and the suite has a watchdog it can be walked into: 90s against a
  ~41s run today, and it was 45s against 45.6s until the sleeps were converted.
  Whatever the check is waiting for, poll for it.

## Running the app

```bash
unset ELECTRON_RUN_AS_NODE
npx electron .                  # add --dev for devtools and renderer logging
```

Only one instance runs at a time (`requestSingleInstanceLock` in `main.mjs`) —
a second launch raises the first window and exits 0 in about a second. That is
correct behaviour, not a failure to start. Kill a stray run with:

```bash
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

## Screenshotting the UI

`capturePage()` on a window created with `show: false` returns a stale frame —
a hidden window has no compositor producing new ones, so a shot taken after a
repaint shows the state before it. Use `show: true`.

Model the harness on `scripts/smoke.mjs`: `setDataRoot(mkdtempSync(...))` and
`registerSchemes()` at module scope, then `serveAssets()` and `registerIpc()`
inside `whenReady`. Write test plugins into `pluginsDir()` **before**
`registerIpc`, which is what starts `plugins.load()`.

Override `pluginRegistry` to a loopback index. Left at the default the app asks
nine real registries, and the store paints `Asking the registry…` for as long as
their timeouts take — the badge and the UPDATE buttons are simply absent until
then, which looks exactly like a broken feature.

## Packaging

```bash
unset ELECTRON_RUN_AS_NODE
npx electron-builder --win      # `npm run dist` is the same thing
ls -la dist/*.exe               # the timestamp is the proof, not the exit code
```

Produces a portable exe, an NSIS installer, its `.blockmap`, and `latest.yml`.
`latest.yml` is what the in-app updater reads: a release without it looks to
every installed copy like no release at all.

Bump `version` in `package.json` before packaging anything meant to be
published. Two different builds under one version number cannot be told apart by
the updater, and electron-builder will overwrite the earlier artefacts without
comment.

## Before saying a change works

`npm test` and `npm run smoke` both pass. The smoke run is the one that catches
a renamed IPC channel, a renderer that throws on boot, a layout that breaks at
one screen shape, or a control that stops resetting what it should — the unit
tests cannot see any of those.

When the fix is for something a user reported, the test reproduces *their* case
rather than a tidy abstraction of it.
