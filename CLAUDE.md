# Working notes

Invariants and traps for anyone — human or agent — changing this codebase.

## Shape of the thing

Electron. Main process owns all state; the renderer owns none. Every asynchronous fact reaches the renderer on **one**
IPC channel (`event`) as `{event, ...payload}`, and every request is an `invoke` returning `{ok, value|error}` which
`preload.cjs` unwraps. Adding an event type needs no change to `ipc.mjs` or `preload.cjs` — only a `case` in the
renderer's `handleEvent`.

The renderer holding no pipeline state is deliberate: a reload can never leave the two disagreeing about whether a turn
is running.

## Traps

**`ELECTRON_RUN_AS_NODE`.** VS Code's integrated terminal sets this. With it set, `npx electron .` runs the binary as
plain Node, `require('electron')` returns a *path string*, and you get a confusing `Cannot read properties of undefined`
in the ESM loader. `unset ELECTRON_RUN_AS_NODE` before launching from a VS Code terminal. This is not an app bug and no
amount of changing imports will fix it.

**Top-level `await app.whenReady()` deadlocks.** Electron holds the ready event until the ESM entry module finishes
evaluating. Use `app.whenReady().then(...)`, as `main.mjs` and `scripts/smoke.mjs` both do.

**Electron on Windows has no attached console.** `console.log` from the main process goes nowhere when stdout is piped.
`scripts/smoke.mjs` writes its report to a file (`SMOKE_REPORT`) for exactly this reason. Renderer console output is
forwarded to the terminal only under `--dev`.

**Preload is `.cjs`, not `.mjs`, on purpose.** An ESM preload only loads with the sandbox disabled.

**`setContentSize` on a hidden window applies on its own schedule.** The layout checks poll `window.innerWidth` until it
matches instead of sleeping a fixed interval — an early version silently measured a viewport that had never changed and
reported three different screen shapes as identical. If you add a shape, keep the poll.

**Windows refuses a content height taller than the work area**, keeping the previous size silently. Shapes taller than
the display are skipped rather than measured.

**Never `emit('error')` on an EventEmitter nothing listens to.** Node rethrows it as an uncaught exception. `LlamaServer`
did this on spawn `ENOENT`, and a missing `llama-server` took the whole app down with a modal "A JavaScript error
occurred in the main process". Failures are reported through the `state` event and the rejected promise instead.

**GNU tar cannot read zip, and `tar` on PATH is often GNU tar.** Windows ships bsdtar in System32, which can — but a
machine with Git installed usually resolves `tar` to Git's GNU tar first. `extractors()` in `llm/tools.mjs` names the
System32 path explicitly, then falls back to PATH, then PowerShell `Expand-Archive`. This failed exactly once, in
development, for exactly this reason.

**`toolsDir()` creates `tools/`, not its subdirectories.** The first llama-server download failed on opening the write
stream because `tools/llama/` did not exist yet.

**Cleanup after an aborted download must not throw.** On Windows the write handle from an aborted `pipeline` is not
always released when we try to delete the partial file, and the resulting `EBUSY` replaces the real error
("cancelled") with a confusing one. `removeWhenReleased` retries briefly and gives up quietly — a leftover `.part` is
harmless; losing the actual reason is not.

**`app.exit()` does not wait for anything.** Teardown promises must be awaited *before* it, and the child processes are
torn down concurrently so a Chrome that will not close cannot eat the budget that would have stopped llama-server.

**Never build a PowerShell command by interpolating a path.** `psQuote` doubles apostrophes; without it a home directory
like `C:\Users\O'Connor` closes the string early and the unpack fails on the user's own name.

## Invariants

**The system prompt must not contradict itself.** It once said "no markdown" one paragraph before requiring a fenced
action block, and a model spent its whole budget deliberating over that instead of answering — the reasoning dump was
"Does the code block count as markdown?" fifty times over. Markdown is rendered now, so the rule permits it and adds
"never deliberate about formatting". `prompts.test.mjs` asserts no rule forbids what the protocol demands.

**Model output is parsed to data and built into DOM nodes, never assigned to `innerHTML`.** `shared/markdown.mjs`
returns plain objects; the renderer turns them into elements. A reply containing `<img onerror=…>` is therefore
displayed rather than run, and the smoke test checks exactly that. Emphasis requires its delimiters to hug the text,
or `2 * 3 * 4 = 24` comes out italicised.

**There is no attach-to-an-existing-browser mode.** The app always launches its own Chrome. Driving tabs the user is
working in, and leaving that browser open afterwards, makes every failure look like the app interfering with their
session.

**A disabled capability is absent from the system prompt, not forbidden in it.** A model told about a tool reaches for
it, and the resulting refusal reads to the user as a bug. `buildSystemPrompt` assembles from parts; `prompts.test.mjs`
guards this.

**Chats persist the raw reply, fences and all.** The model needs to see its own actions on the next turn.
`stripActionBlocks` is a *view*, applied at render time only. Never write stripped text back to storage.

**Roles are stored structurally.** The original stored a flat `> prompt\nreply` transcript because C had no JSON; here a
reply that itself begins with `> ` cannot be mistaken for a new turn. There is a test for that specific case.

**`web_lookup` uses a second, headless browser.** Its entire purpose is not disturbing the tab the user is looking at, so
it must never share the visible session.

**The follow-up loop is bounded** (`MAX_FOLLOW_UPS = 3`). A model that keeps emitting actions after every result will
otherwise loop forever.

**A failed browser step stops the batch.** Every following step assumes a page state that no longer holds; carrying on
only piles up noise.

**`reply:start` owes a `reply:end` on every path, including the failing one.** The start event puts a live,
cursor-blinking element on screen; without the matching end a dead endpoint leaves a blinking cursor in the transcript
forever. `turn:end` is handled in the renderer as a second backstop.

**Preconditions are checked before anything is persisted.** `send()` refuses with no usable endpoint *before* creating
the chat, so a failed send leaves no orphan user turn in the history — which is also what lets the renderer hand the
text back to the composer. The renderer keys that decision on whether `turn:start` arrived: after it, the message is
recorded and returning it would duplicate it.

**`compact()` refuses while a turn is running.** It rewrites the whole message list, and a turn appending to the same
file at that moment loses messages.

**The context meter is recomputed on every chat load**, not only mid-turn. `agent.contextFor(chatId)` exists for this:
without it the meter keeps the previous conversation's number after NEW CHAT, which users read — correctly — as the
context not having been cleared.

**An external model is a reference, never a copy, and never ours to delete.** `[ OPEN FILE… ]` stores an absolute path
in `config.externalModels`; the file stays where the user put it. `remove()` deletes only from the vault,
`forgetExternal()` only drops the reference — the two are deliberately separate functions with separate buttons (`×`
versus `⊘`), because one glyph doing both would eventually delete somebody's model. A registered file that has gone
missing stays listed and marked, since an unplugged drive is not the same as a mistake.

`resolve('')` returns the working directory, so emptiness is checked *before* resolving — otherwise an empty pick
reports "not a file" and points at the repo root.

**Context size comes from the model header, not from file size.** `llm/gguf.mjs` parses the GGUF metadata block for
`context_length`, `block_count`, `embedding_length` and the head counts. File size cannot answer the question: KV cost
per token varies tenfold between models of the same size depending on layers and grouped-query attention, and the
trained context is a hard cap that has nothing to do with either. Only the header is read, never the tensors — the
tokenizer vocabulary lives in that metadata too, so the reader grows its window (256 KB → 4 MB → 32 MB) and skips array
payloads rather than materialising them.

With AUTO off the slider value is passed through **exactly**, including one the model cannot honour. An explicit
setting that is silently overridden is worse than one that fails loudly.

**`readText` falls back to the whole page body when its selector matches
nothing** — the engine documents this in `page_text_probe.js`. Presence cannot be inferred from a non-empty answer:
the ad watcher reads `body` as well and treats an identical answer as "not found". Without that it picked the first
short line off YouTube and clicked it every few seconds. `scripts/adskip-live.mjs` has a bystander button that proves
it does not.

**The engine has no top-level JS evaluation.** `page.eval` and `page.url` exist only inside a handler callback, so an
injected page-side watcher is not possible; detection has to go through `readText`/`read`/`state` and a DSL step. The
binding exposes `session.pageEval`, which the engine answers with `unknown cmd`.

**manul reuses one Chrome per profile.** Two `BrowserBridge` instances open at once look at the same page — which made
a live check "fail" with nothing wrong in the code under test. Close one before opening another.

**A chat id becomes a filename, so it is validated first.** `isSafeId` in `chats.mjs` admits only `[A-Za-z0-9_-]`.
Ids arrive from IPC and are interpolated into a path; without the check a `../` in one would reach outside `chats/`.

**A `.part` file surviving a failed download is the feature, not litter.** It is what `Range`-based resuming reads the
offset from. `resumed` requires a 206 *and* bytes already on disk — a server volunteering 206 with nothing to resume
would otherwise open the writer in append mode. A server that ignores the range answers 200, and then starting over is
correct: appending a full body to a partial file corrupts it silently.

**A download with no bytes for 90s is abandoned.** Only one runs at a time, so a dead connection otherwise leaves every
later attempt refused as busy while nothing moves — which reads as "it says it is downloading and does nothing".

**Context is traded down for full GPU offload, never the other way round.** `contextForFullOffload` solves
`share·VRAM − overhead − context·KV ≥ weights` directly — no search — and returns 0 when the weights alone do not fit or
when only a uselessly short context would. It shares `GPU_SHARE` and `GPU_OVERHEAD_BYTES` with `recommendGpuLayers`
precisely so the two cannot disagree about what fits. Measured on a 12 GB card with Qwen3.5-9B: 61.4 tok/s at 15360 with
every layer resident, against 18.5 tok/s at 32768 with 23 of 32 — the trade is worth roughly 3×.

**The size-only placement estimate reserves a third of the card.** The KV cache is not a rounding error: on a 9B at 32k
it is several gigabytes, and an earlier "size + 25%" margin labelled models GPU-resident that in fact ran two thirds of
their layers on the CPU. Exact placement comes from the header via `models/placement.mjs`; the estimate is only for
search results, where the header is inside a file we have not downloaded.

**An exit code is not a diagnosis.** `llama-server exited (1)` named no cause and suggested no fix. The last 60 lines of
its output are kept and `summariseFailure` turns them into a sentence, naming the remedy for the failures that have one
(VRAM exhaustion, a port clash, an unknown flag). Classification runs on the **raw** lines: llama.cpp's severity marker
is a bare `E` field, and an earlier version stripped it for readability *before* looking for it, so every unrecognised
failure reported the cleanup message that follows the real error.

**A model's reply can arrive in `reasoning_content`, not `content`.** llama.cpp parses each family's thinking syntax —
`<think>` tags, harmony channel markers — into that field by default. A client reading only `content` shows an empty
reply for a model that thinks first, which is what a 30B did here. `streamChat` reads both and folds the thinking into a
`<think>` block, which the chat view already renders dimmed. Do not "fix" this with `--reasoning-format none`: that
leaves the syntax unparsed and a harmony model prints `to=self<|message|>` at the user.

**A spawn failure reports once.** Node emits `error` then `exit`; the first carries the real reason ("not found") and
the second would replace it with a line derived from an empty log. The `exit` handler bails out if the state is already
`error`.

**`unload()` does not wait for a process that has already gone.** `proc.once('exit')` never fires for one that exited,
so the 3-second fallback was paid in full on every unload after a crash — including on the way out of the app.

**`paintContextControls` and `paintGpuControls` own their whole row.** Nothing may write `val-nctx` or `val-ngl` after
them; `applySettings` used to, and the label read `999` while AUTO was deciding.

**The llama.cpp release is resolved from the GitHub API, not pinned.** A pin goes stale two ways: the tag 404s, or it
predates a flag we pass and the server exits with "invalid argument". `PINNED_TAG` is only a fallback for when the API
is unreachable. When changing the flags in `server.mjs`, check them against a current build's `--help`.

**`MANUL_BINARY` set by the user wins, and the app never writes it.** The bundled engine is passed per session as the
binding's `binary` option instead of through `process.env` — an env mutation is permanent for the life of the process
and invisible to anything reading it later. The option is omitted when the user set `MANUL_BINARY`, because an explicit
option outranks the env var inside the binding and passing it would invert their override.

**The browser engine's repository is `manul-browser`, not `Manul`.** The Go module is
`github.com/alexbeatnik/manul-browser/core`. A local clone may sit under an older directory name, so `shared/engine.mjs`
searches `../manul-browser`, `../Manul`, `../ManulEngineGo` in that order — canonical name first. Never hard-code one of
them: an early version pinned `../Manul` and would have found nothing on any machine that cloned the repo by its real
name.

**There is no npm dependency on `manul-browser`, on purpose.** A `file:` dependency must hard-code one directory name,
and npm resolves dependencies before any script could correct it. The binding is loaded by path at runtime
(`loadBinding` in `browser/manul-browser.mjs`), trying the installed package first so this keeps working if the package
is ever published.

**The engine binary keeps the name `manul`.** That is manul-browser's own CLI name and what its `findBinary` looks for.
Renaming the file to match this repo's naming would be wrong.

## Packaging

`npm run engine` stages both halves into `resources/` — `bin/manul.exe` (built) and `manul-browser/` (the binding's
compiled `dist`, copied). Both are gitignored build output. `npm run dist` re-stages, then runs electron-builder, which
ships `resources/` through `extraResources`.

**A packaged app cannot reach the checkout**, so anything the engine or binding needs must be staged before the build.
`resourceRoots()` in `browser/manul-browser.mjs` looks in `process.resourcesPath` first, then the repository's
`resources/`. It deliberately does not consult `app.isPackaged`: in development `process.resourcesPath` points into
Electron's own dist, which holds neither, so the check falls through on its own — and this file stays importable without
`electron`, which is what lets `bundled.test.mjs` exercise the packaged path in plain Node.

That test matters more than it looks: packaged-only resolution is invisible from source, and getting it wrong shows up
as browser control silently missing in a shipped `.exe`.

## Text handling

`src/shared/render.mjs` holds the shaping both processes need (`ACTION_RE`, `stripActionBlocks`, `splitThinking`,
`formatSize`). One definition imported twice, so main and renderer cannot drift on what counts as prose.

Action JSON arrives malformed often. `parseActionPayload` tries, in order: the first *balanced* `{...}` (string- and
escape-aware, so a `}` inside the DSL does not truncate it), then a repair pass for the known truncation where a small
model closes the DSL string with an apostrophe and forgets the outer `"}`. The repair runs only after a clean parse has
already failed — payloads that were invalid for a real reason must not be quietly "fixed" into something else.

`<think>` is only recognised at the start of a line. Models discuss `<think>` in prose often enough that a naive match
turns a normal answer into a dimmed reasoning block.

## Layout

`styles.css` keys its column count on **aspect ratio**, not width. A 4:3 panel and an ultrawide can report similar
widths and want opposite layouts. Three regimes: `max-aspect-ratio: 4/3` (dense two-column), `min-aspect-ratio: 16/10`
and `min-width: 1500px` (three columns with the activity log), `max-width: 900px` (overlay drawer). Changing any of
these means updating `SHAPES` in `scripts/smoke.mjs`.

## Testing

Three levels, and each exists because the one below it cannot see the failure:

`npm test` — pure logic, no Electron, no network. Fast enough to run on every change.

`npm run smoke` — boots the real window offscreen and drives it. This is what catches a renamed IPC channel, a renderer
that throws on boot, a layout that breaks at one screen shape, or a control that stops resetting what it should. Both of
these must pass.

`npm run adskip:live` — a real Chrome against a locally served page. Kept separate because it needs a browser and takes
half a minute; run it when touching `browser/`.

When a fix is for something a user reported, the test should reproduce *their* case, not a tidy abstraction of it. The
numbers in `gpu.test.mjs` are a 25 GB model on a 12 GB card because that is what failed; the log excerpt in
`failure.test.mjs` is verbatim from the crash it explains.

**Probes that spawn a model or a browser must clean up on the way out.** One killed by a `timeout` left an orphaned
llama-server holding port 8080, and the app then reported a model as loaded while talking to it — a wrong answer that
looked exactly like a right one. Trap the signals, or use a different port.
