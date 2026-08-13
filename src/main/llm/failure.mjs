/**
 * Turning a llama-server crash into something a person can act on.
 *
 * An exit code by itself — "llama-server exited (1)" — names no cause and
 * suggests no fix. The reason is always in the last few lines of stderr; this
 * finds it, and for the failures that have an obvious remedy, says what it is.
 */

/**
 * Failures worth naming, most specific first.
 *
 * Each pattern is one the user can do something about. Anything unmatched
 * falls through to the raw log line, which is still far better than a number.
 */
const KNOWN = [
  {
    match: /out of device memory|ErrorOutOfDeviceMemory|failed to allocate .*(Vulkan|CUDA|ROCm)|cudaMalloc failed|unable to allocate .*buffer/i,
    say: 'the model does not fit in VRAM — lower GPU LAYERS, or turn its AUTO back on',
  },
  {
    match: /bind.*(address|port)|address already in use|EADDRINUSE|failed to bind/i,
    say: 'the port is already in use — another llama-server is probably still running',
  },
  {
    match: /std::bad_alloc|out of memory|cannot allocate memory|failed to allocate.*buffer of size/i,
    say: 'out of memory — try a smaller model, a smaller context, or fewer GPU layers',
  },
  {
    match: /unknown (argument|option)|invalid argument|unrecognized/i,
    say: 'this llama-server build does not accept an option we passed — update it',
  },
  {
    match: /failed to load model|error loading model|no such file/i,
    say: 'the model file could not be loaded — it may be corrupt or truncated',
  },
  {
    match: /unsupported model architecture|unknown model architecture|unsupported.*arch/i,
    say: 'this llama-server build does not support the model architecture — update it',
  },
];

/**
 * Does this line look like a complaint?
 *
 * Tested against the **raw** line, because llama.cpp's severity marker — a bare
 * `E` field after the timestamp — is the most reliable signal there is, and
 * `tidy` removes it. Classifying tidied text threw that away and made every
 * unrecognised failure report the cleanup message that follows it.
 */
const ERROR_LINE = /^\d[\d.]*\s+E\s|\bE\s|error|failed|cannot|unable/i;

/** Timestamps and severity markers are noise once the line is the headline. */
function tidy(line) {
  return String(line)
    .replace(/^\d+\.\d+\.\d+\.\d+\s+/, '')
    .replace(/^[EWID]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Explain why the server stopped.
 *
 * `lines` is the tail of its output, oldest first. Returns a single sentence:
 * a named cause when one is recognised, otherwise the most relevant log line.
 */
export function summariseFailure(lines, { code = null, signal = null } = {}) {
  const raw = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? '')).filter((line) => line.trim());

  const known = KNOWN.find((entry) => entry.match.test(raw.join('\n')));
  if (known) return known.say;

  // No recognised cause: quote the last line that looks like a complaint. The
  // true error is rarely the final line — cleanup messages usually are.
  const complaint = [...raw].reverse().find((line) => ERROR_LINE.test(line));
  if (complaint) return tidy(complaint).slice(0, 200);

  if (raw.length > 0) return tidy(raw[raw.length - 1]).slice(0, 200);
  return `llama-server exited (${signal ?? code ?? 'unknown'}) without saying why`;
}
