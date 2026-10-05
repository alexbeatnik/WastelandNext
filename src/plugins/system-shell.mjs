/**
 * Running a shell command, as a plugin.
 *
 * The approval dialog is *not* here. `turn.confirm` is a service of the turn
 * itself, so the question reaches the user through the app's own modal however
 * many plugins end up wanting to ask it — and no plugin can arrange to skip it
 * by not calling anything.
 */
import { spawn } from 'node:child_process';

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
 * Everywhere else it is the same hole with a different shape. `sh -c` runs the
 * command as a child of the shell — dash, which is `/bin/sh` on Debian and
 * Ubuntu, does not replace itself with it — so a signal to the shell leaves
 * the command running. The first version of this said a POSIX shell could be
 * left to `kill` alone, and the tests said otherwise the first time they ran
 * on Linux. The command is therefore started as the leader of its own process
 * group (`detached`, in `runCommand`), and a negative pid signals the whole
 * group.
 *
 * The pipes are destroyed as well: `close` waits for them, and anything still
 * holding one would keep the turn waiting on a command that has been told to
 * stop.
 */
function killTree(child, signal = 'SIGTERM') {
  const finish = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill(signal);
  };
  if (!child.pid) return finish();

  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* the group is already gone, which is the outcome being asked for */
    }
    return finish();
  }

  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  // Either way the shell itself still has to go: `error` is a machine with no
  // `taskkill` on PATH, and `close` is the tree gone or refusing to be.
  killer.once('error', finish);
  killer.once('close', finish);
}

/** As much output as is kept. Past it the command is stopped, as `exec` did. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** How long a stopped command gets to go quietly before it is made to. */
const KILL_GRACE_MS = 3000;

/**
 * Run one approved command to its end — its own, Stop's, or the timeout's.
 *
 * Answers `{ok, ended, text}`, where `ended` says what stopped it: `'stopped'`
 * for Stop, `'timeout'`, `'flood'` for more output than is kept, or `''` for a
 * command that finished by itself. Stop used to do nothing here: the signal
 * reached the handler and was never passed on, so the turn sat on "Running…"
 * for as long as the command cared to take.
 *
 * `spawn` rather than `exec`, for one option: `exec` cannot start a process
 * as the leader of its own group, and without that there is no way to stop a
 * command on Linux or macOS — see `killTree`. Not on Windows, where `detached`
 * means a console window of its own and `taskkill` already walks the tree.
 */
export function runCommand(command, { signal = null, timeoutMs = TIMEOUT_MS } = {}) {
  // Before anything is spawned. A listener added to a signal that has already
  // fired never runs, and the command would then be started for a turn that
  // had been stopped.
  if (signal?.aborted) return Promise.resolve({ ok: false, ended: 'stopped', text: '(not run)' });

  return new Promise((resolve) => {
    let ended = '';
    let failure = '';
    let settled = false;
    let timer = null;
    let force = null;
    let kept = 0;
    const out = [];
    const err = [];

    const child = spawn(shellCommandFor(command), { shell: true, detached: process.platform !== 'win32' });

    const end = (why) => {
      if (ended || settled) return;
      ended = why;
      killTree(child);
      // A command that ignores being asked is not thereby allowed to keep the
      // turn. Unreferenced, so a grace period never holds the app open.
      force = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
      force.unref?.();
    };
    const onAbort = () => end('stopped');

    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener('abort', onAbort);

      // Joined as bytes and decoded once, so a character split across two
      // chunks is still a character.
      const printed = `${Buffer.concat(out).toString('utf8')}${Buffer.concat(err).toString('utf8')}`.trim();
      const note =
        ended === 'timeout'
          ? `(did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped)`
          : ended === 'flood'
            ? '(stopped: it printed more than this keeps)'
            : '';
      const quiet = failure || (code === 0 ? '(no output)' : `exited with code ${code ?? 'unknown'}`);
      resolve({
        ok: code === 0 && !ended && !failure,
        ended,
        text: note ? `${printed}\n${note}`.trim() : printed || quiet,
      });
    };

    const keep = (list) => (chunk) => {
      kept += chunk.length;
      if (kept > MAX_OUTPUT_BYTES) return end('flood');
      list.push(chunk);
    };
    child.stdout?.on('data', keep(out));
    child.stderr?.on('data', keep(err));
    // No shell to run it in at all. `close` may not follow, so this settles.
    child.once('error', (problem) => {
      failure = problem.message;
      settle(null);
    });
    child.once('close', (code) => settle(code));

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
