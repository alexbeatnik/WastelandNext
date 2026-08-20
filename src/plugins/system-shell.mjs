/**
 * Running a shell command, as a plugin.
 *
 * The approval dialog is *not* here. `turn.confirm` is a service of the turn
 * itself, so the question reaches the user through the app's own modal however
 * many plugins end up wanting to ask it — and no plugin can arrange to skip it
 * by not calling anything.
 */
import { exec } from 'node:child_process';

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
  const output = await new Promise((resolve) => {
    exec(shellCommandFor(command), { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, text: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err ? err.message : '(no output)') });
    });
  });

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
