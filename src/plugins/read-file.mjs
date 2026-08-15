/**
 * Reading one file, as a plugin.
 *
 * The vetting stays in `readfile.mjs`: a path the *model* named is a request to
 * be checked, and where that check lives must not depend on which plugin asked.
 */
import { readForModel } from '../main/agent/readfile.mjs';

export const manifest = {
  id: 'read-file',
  name: 'File reading',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Lets the model read one file at a time, read-only, from inside your home directory.',
  actions: ['read_file'],
  services: [],
  order: 30,
  legacy: ['allowReadFile'],
};

const PROMPT = `
FILES — {"type":"read_file","steps":"<path>"}

Reads one file, read-only, so you can summarise or answer questions about it.
Paths stay inside the user's home directory. You cannot write files.`;

export function activate(ctx) {
  ctx.prompt(PROMPT);
  ctx.action({
    type: 'read_file',
    run: async (path, turn) => {
      turn.status('Reading…');
      const result = await readForModel(path);
      if (!result.ok) {
        return { ok: false, summary: `${path}: ${result.reason}`, feedback: `[READ FAILED] ${path}: ${result.reason}` };
      }
      return {
        ok: true,
        summary: `${result.path} (${result.size} bytes)`,
        feedback: `[FILE] ${result.path}\n\n${result.content}\n\n[END FILE] Answer the user's question about this file concisely.`,
      };
    },
  });
}
