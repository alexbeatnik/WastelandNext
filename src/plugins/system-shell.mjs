/**
 * Running a shell command, as a plugin.
 *
 * The approval dialog is *not* here. `turn.confirm` is a service of the turn
 * itself, so the question reaches the user through the app's own modal however
 * many plugins end up wanting to ask it — and no plugin can arrange to skip it
 * by not calling anything.
 */
import { exec, spawn } from 'node:child_process';

export const manifest = {
  id: 'system-shell',
  name: 'Shell commands',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Lets the model propose a shell command. Nothing runs until you approve it.',
  actions: ['system_shell'],
  services: [],
  category: 'capability',
  order: 40,
  // The one capability that has always been off until asked for.
  enabledByDefault: false,
  legacy: ['allowShell'],
};

const PROMPT = `
SHELL — {"type":"system_shell","steps":"<command>"}

For work outside the browser (open a folder, list files, run a build). Every
command is shown to the user and runs only after they approve it, so write the
command you actually mean and explain it in one sentence first.`;

/** Killed rather than left hanging the pipeline. */
const TIMEOUT_MS = 120_000;

/**
 * The command as the shell will actually receive it.
 *
 * `exec` runs a Windows command through `cmd.exe`, which renders its output in
 * the console's code page — 866 on a Ukrainian or Russian install, 437 on an
 * English one — while Node decodes what comes back as UTF-8. On 437 the loss is
 * total rather than cosmetic: `dir` over a folder with Cyrillic names writes a
 * literal `?` per character, so no amount of decoding afterwards can recover
 * them, and the model is asked to summarise a row of question marks.
 *
 * `chcp` has to run in a *different* `cmd` from the command it is for. The
 * obvious `chcp 65001>nul & <command>` reads perfectly and does nothing: an
 * instance caches the code page at startup, so the change lands on the console
 * and the very next command in that same instance still writes 437. It is the
 * *next* process that picks it up — measured, not reasoned about — which is why
 * the command is handed to a nested `cmd /d /s /c` that starts afterwards.
 *
 * The command the user approved is untouched inside those quotes, where `cmd`
 * leaves `&`, `|` and `^` alone, and it stays the last thing on the line so its
 * exit code is still the one `exec` reports. The one thing it does pay is a
 * second `%VAR%` expansion pass, which changes nothing unless a variable's own
 * value contains `%something%`.
 */
export function shellCommandFor(command, platform = process.platform) {
  return platform === 'win32' ? `chcp 65001>nul & cmd /d /s /c "${command}"` : command;
}

/**
 * End a command, and whatever it started.
 *
 * `child.kill()` ends the process `exec` spawned, which is the shell — and on
 * Windows the command is two `cmd`s below that (see `shellCommandFor`), so
 * killing the top one orphans the thing that was meant to stop. Measured, not
 * assumed: a `ping` stopped that way was still in the task list afterwards,
 * with the turn reporting it as ended. `taskkill /T` walks the tree.
 *
 * The pipes are destroyed as well, which is what `exec` does for its own
 * timeout: its callback waits for them to close, and anything still holding
 * one would keep the turn waiting on a command that has been told to stop.
 *
 * A POSIX shell is left to `kill` alone. `exec` offers no way to start one in
 * its own process group, and `sh -c` hands a simple command its own process
 * anyway.
 */
function killTree(child) {
  const finish = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill();
  };
  if (process.platform !== 'win32' || !child.pid) return finish();

  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  // Either way the shell itself still has to go: `error` is a machine with no
  // `taskkill` on PATH, and `close` is the tree gone or refusing to be.
  killer.once('error', finish);
  killer.once('close', finish);
}

/**
 * Run one approved command to its end — its own, Stop's, or the timeout's.
 *
 * Answers `{ok, ended, text}`, where `ended` is `'stopped'`, `'timeout'` or
 * `''` for a command that finished by itself. Stop used to do nothing here:
 * the signal reached the handler and was never passed on, so the turn sat on
 * "Running…" for as long as the command cared to take.
 */
export function runCommand(command, { signal = null, timeoutMs = TIMEOUT_MS } = {}) {
  // Before anything is spawned. A listener added to a signal that has already
  // fired never runs, and the command would then be started for a turn that
  // had been stopped.
  if (signal?.aborted) return Promise.resolve({ ok: false, ended: 'stopped', text: '(not run)' });

  return new Promise((resolve) => {
    let ended = '';
    let timer = null;
    const end = (why) => {
      if (ended) return;
      ended = why;
      killTree(child);
    };
    const onAbort = () => end('stopped');

    const child = exec(shellCommandFor(command), { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const printed = `${stdout ?? ''}${stderr ?? ''}`.trim();
      const text =
        ended === 'timeout'
          ? `${printed}\n(did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped)`.trim()
          : printed || (err ? err.message : '(no output)');
      resolve({ ok: !err && !ended, ended, text });
    });

    timer = setTimeout(() => end('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function run(command, turn) {
  const approved = await turn.confirm({ kind: 'shell', command });
  if (!approved) {
    return {
      ok: false,
      summary: 'declined',
      feedback: `[SHELL DECLINED] The user did not approve \`${command}\`. Do not retry it.`,
    };
  }

  turn.status('Running…');
  const output = await runCommand(command, { signal: turn.signal });
  if (output.ended === 'stopped') {
    return {
      ok: false,
      summary: 'stopped',
      feedback: `[SHELL STOPPED] The user stopped \`${command}\` before it finished. Do not retry it.`,
    };
  }

  return {
    ok: output.ok,
    summary: output.text.slice(0, 200),
    feedback: `[SHELL] \`${command}\` ${output.ok ? 'succeeded' : 'failed'}:\n${output.text.slice(0, 4000)}\n\nSummarise this for the user in one or two sentences.`,
  };
}

export function activate(ctx) {
  ctx.prompt(PROMPT);
  ctx.action({ type: 'system_shell', run });
}
