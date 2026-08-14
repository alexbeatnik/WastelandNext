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
 * Where to get a current Microsoft Visual C++ runtime.
 *
 * Named here rather than in the summary itself because the summary is drawn in
 * the status bar, uppercased, where a URL is neither readable nor clickable.
 * The activity log is where it belongs.
 */
export const VCREDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/**
 * Windows does not exit a faulting process, it kills it — and the NTSTATUS
 * value lands where an exit code would go. 3221225477 is 0xC0000005, an access
 * violation, and reporting the number is exactly the "exit code as diagnosis"
 * this module exists to avoid.
 *
 * No platform check guards this. Nothing below 0xC0000000 is one of these, and
 * no ordinary exit code reaches that high on any platform — POSIX has eight
 * bits — so the two can never be confused for one another.
 */
const CRASH_FLOOR = 0xc0000000;

/**
 * Crashes worth naming.
 *
 * `silent` is used when the process died without printing a single line, which
 * narrows the cause sharply: a fault that early is a load-time problem with the
 * build or its dependencies, not anything to do with the model. `say` covers a
 * crash that got far enough to talk first.
 */
const CRASHES = new Map([
  [
    0xc0000005,
    {
      name: 'access violation',
      // Observed: llama.cpp built with a current toolchain against a machine
      // whose redistributable was three years old. The DLL loads — so there is
      // no "missing DLL" to go on — and then faults before `main` runs.
      silent: 'llama-server crashed at startup — its Microsoft Visual C++ runtime is too old for this build',
      hint: `install the latest x64 redistributable: ${VCREDIST_URL}`,
      say: 'llama-server crashed with an access violation — a fault inside it or in a GPU driver',
    },
  ],
  [
    0xc0000135,
    {
      name: 'missing DLL',
      silent: 'llama-server is missing a DLL it needs — the download looks incomplete',
      hint: 'delete the tools/llama folder and let it fetch llama-server again',
    },
  ],
  [
    0xc0000139,
    {
      name: 'missing entry point',
      silent: 'llama-server loaded a DLL of the wrong version — tools/llama holds a mix of two builds',
      hint: 'delete the tools/llama folder and let it fetch llama-server again',
    },
  ],
  [
    0xc0000142,
    {
      name: 'DLL initialisation failed',
      silent: 'a DLL llama-server needs failed to initialise — its Visual C++ runtime may be too old',
      hint: `install the latest x64 redistributable: ${VCREDIST_URL}`,
    },
  ],
  [
    0xc000007b,
    {
      name: 'wrong architecture',
      silent: 'this llama-server build is for a different processor architecture',
      hint: 'delete the tools/llama folder and let it fetch a build for this machine',
    },
  ],
  [
    0xc000001d,
    {
      name: 'illegal instruction',
      silent: 'this llama-server build needs CPU instructions this processor does not have',
      say: 'llama-server hit an instruction this processor does not have — the build is for a newer CPU',
      hint: 'a build for an older CPU (AVX2 rather than AVX-512) is needed',
    },
  ],
  [0xc0000017, { name: 'out of memory', say: 'llama-server ran out of memory' }],
  [0xc00000fd, { name: 'stack overflow' }],
  // MSVC raises this for `abort()`, which is what a failed GGML_ASSERT calls.
  [0xc0000409, { name: 'a failed internal check' }],
  [0xc0000602, { name: 'a failed internal check' }],
  [0xc0000374, { name: 'heap corruption', hint: 'this is a bug in the build — try fetching llama-server again' }],
  [0xc000013a, { name: 'interrupted' }],
]);

/**
 * A Windows crash status, or null for anything that is an ordinary exit code.
 *
 * Node reports these unsigned; a shell hands back the signed reading of the
 * same 32 bits (-1073741819 for 0xC0000005), so both are accepted.
 */
function crashStatus(code) {
  if (typeof code !== 'number' || !Number.isInteger(code)) return null;
  const value = code < 0 ? code + 0x1_0000_0000 : code;
  return value >= CRASH_FLOOR && value <= 0xffff_ffff ? value : null;
}

/**
 * Explain a crash from its exit code alone.
 *
 * Returns `{summary, hint}` — the summary for the status bar, the hint for the
 * log, where there is room for a URL. Null when the code is an ordinary one and
 * therefore says nothing a log line would not say better.
 */
export function explainCrash(code, { silent = false } = {}) {
  const value = crashStatus(code);
  if (value === null) return null;

  const hex = `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
  const known = CRASHES.get(value);
  if (!known) {
    return {
      summary: silent
        ? `llama-server crashed at startup (${hex}) without printing anything`
        : `llama-server crashed (${hex})`,
      hint: null,
    };
  }

  const summary =
    (silent ? known.silent : known.say) ??
    (silent
      ? `llama-server crashed at startup (${known.name}) without printing anything`
      : `llama-server crashed (${known.name})`);
  return { summary, hint: known.hint ?? null };
}

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

  // Nothing in the log explains it, so the exit code is the only evidence left
  // — and on Windows it is evidence, not just a number. This sits below the log
  // checks because a process that said what was wrong is always worth quoting,
  // and above the fallback because a benign last line ("loaded RPC backend")
  // read as the reason for a crash points at the wrong thing entirely.
  const crash = explainCrash(code, { silent: raw.length === 0 });
  if (crash) return crash.summary;

  if (raw.length > 0) return tidy(raw[raw.length - 1]).slice(0, 200);

  // Nothing printed and nothing wrong, by its own account. Reaching here at all
  // means it stopped while we were waiting for it to serve, and the likeliest
  // reason is that it was never llama-server — an executable picked in SETTINGS
  // that runs, succeeds and has nothing to do with inference. "exited (0)
  // without saying why" describes that as a mystery when it has an answer.
  if (code === 0) return 'llama-server exited without starting a server — is this the right binary?';

  return `llama-server exited (${signal ?? code ?? 'unknown'}) without saying why`;
}
