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

**`File.path` no longer exists.** It was Electron's own extension to the web `File` object and was removed in Electron
32; this app is on 34, so a renderer reading `file.path` on a drop gets `undefined` for every file and the drop looks
like it was ignored. The path comes from `webUtils.getPathForFile`, which lives only in the preload — that is the point,
since it is what stops the renderer turning an arbitrary `File` into a path on its own. It works in a sandboxed preload,
so the sandbox stays on.

**`app.getVersion()` answers with *Electron's* version when it cannot find the app manifest.** `electron
scripts/smoke.mjs` is exactly that case, so the About box read `Version 34.5.8` and the check — which only asserted a
version-shaped string — passed on it. `VERSION` in `ipc.mjs` parses our own `package.json` through a URL relative to
the module, which resolves inside `app.asar` too: this file is at `src/main/ipc.mjs` and the manifest at the archive
root, packaged or not. The smoke check compares against the manifest rather than against a shape, because a version
field confidently displaying the wrong number is worse than one that fails.

**Every link in the About box needs `target="_blank"`.** That is what routes it through `setWindowOpenHandler` into
`shell.openExternal`. Without it the chat window itself navigates to GitHub, and there is no way back — no address bar,
no back button. The smoke check asserts it on every anchor in the dialog, not just the first.

**The `hidden` attribute loses to any author-level `display`.** `hidden` is nothing but the UA rule
`[hidden] { display: none }`, and the weakest author declaration outranks the whole UA sheet — so `.drop-veil
{ display: flex }` left the veil sitting over the transcript from boot, attribute faithfully set the entire time. Every
element styled with a `display` *and* toggled by `hidden` needs its own `[hidden] { display: none }`; `.modal[hidden]`
already did, and the veil was written without noticing why. A smoke check that reads `node.hidden` cannot see this —
it passed while the bug was on screen. **Assert on `getComputedStyle(node).display`, never on the attribute**: what the
attribute says and what the user sees are different questions, and only the second one is worth a check.

**The drop veil is held up by a re-armed timer, not by counting `dragenter` against `dragleave`.** `dragover` repeats
for as long as something is over the window, so a short timer re-armed on each one takes the veil down the moment the
events stop — cursor left, Escape pressed, dropped on another window. Counting cannot do that: `dragleave` is not
guaranteed to balance `dragenter` at the window edge, and one missed leave leaves the veil up for the rest of the
session.

**`dragover` must call `preventDefault()` or `drop` never fires.** Chromium's default for a dropped file is to navigate
to it, which in this window replaces the app with a file viewer and no way back. `dragenter`/`dragleave` are counted,
not toggled: crossing into a child element fires `dragleave` on the parent *after* `dragenter` on the child, so a
boolean blinks the veil off every time the cursor passes over a message. The veil itself is `pointer-events: none`, or
it becomes the drag target the instant it appears and flickers under the cursor.

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

**A step reporting `ok` means the engine resolved a target and acted on it — not that the page did what was wanted.**
The feedback says so in those words, because an earlier "All N step(s) succeeded" let a model conclude a sort had
applied when it had not, and repeat the identical batch five times. `BatchGuard` refuses an exact repeat within a turn
and names a way forward; a bare refusal tends to produce the same batch again, apologetically.

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

**Compaction is checked before every model call, not only at the start of a turn.** A browsing turn grows its own
history — each batch appends a page map — so three follow-ups can cross the window with no new user message; a real
session reached 8562 of 15360 without ever triggering. The estimate includes the page context for the same reason: it
is part of every prompt and, on a busy site, the largest part. `shouldCompact` is exported and tested on its own.

**The window holds the prompt *and* the reply, so the prompt is budgeted against `max − REPLY_RESERVE`.** Measuring the
prompt against the whole window says a conversation is fine right up to the point where there is no room left to answer:
a real session reached 4594 of 4608, which is 99% full and fourteen tokens from silence — the model emitted a few words
and stopped mid-sentence, which reads as the app cutting it off. `promptBudget` is what `shouldCompact` divides by, and
it never returns more than half a window smaller than twice the reserve.

**`fitToWindow` is the backstop for when compaction could not shrink enough.** Compaction keeps `KEEP_MESSAGES`
verbatim, and one pasted README in that tail fills a small window on its own — so it can run, succeed, and leave the
prompt still over the line. Nothing downstream noticed: the turn went out anyway and llama.cpp chose what to discard,
which is how a model came to answer a conversation whose beginning had silently vanished. The system prompt and the
newest message always survive; anything else goes oldest-first, and a newest message oversized on its own is cut from
the middle so a pasted document keeps both what it is and the question appended under it. It returns new objects — the
stored history is never mutated.

**Thinking is persisted but never resent.** `<think>` is part of the raw reply and the view dims it, but
`#buildMessages` puts assistant turns through `stripThinking` first. A model re-reads its own deliberation as settled
fact, and on a small window the deliberation dwarfs the answer — a 4608-token session was full after two turns, almost
entirely of reasoning already finished with. Every other provider drops prior reasoning for the same reason. Action
fences deliberately survive: the model does need to see what it did. A reply that never got past thinking strips to
nothing, so a short placeholder stands in rather than an empty assistant turn — two user messages in a row run together
in some chat templates.

**`estimateTokens` counts Cyrillic separately from Latin.** One ratio cannot serve both: Latin prose runs about 3.6
characters to the token, Ukrainian nearer 1.6, because few tokenizers hold whole words and the rest falls back to byte
pairs. A single 3.6 undercounted a Ukrainian conversation by roughly half — the meter read 99% while the prompt was
already over the window. The estimate is deliberately the pessimistic one: guessing low costs a truncated prompt,
guessing high costs one compaction sooner than needed.

**Context is never traded below `MIN_TRADED_CONTEXT` (8192) for full GPU offload.** The floor was 4096 and a 12 GB card
duly settled on 4608, which this app cannot live in: the system prompt, a page map and one pasted document are a few
thousand tokens before the user has said anything. Below 8192 the trade is refused, the configured context stands, and
some layers run on the CPU — a model that forgets what it was asked is not worth 3× the tokens per second.

**`compact()` refuses while a turn is running.** It rewrites the whole message list, and a turn appending to the same
file at that moment loses messages.

**The conversation picker is not a `<select>`, and cannot become one again.** Every row carries its own delete, which a
native option cannot hold. Deleting from the list must not open the conversation first: the only way to delete one used
to be to switch to it, which loads a transcript and recomputes the meter for something about to be thrown away.
Deleting the chat that is *on screen* clears the transcript with it; deleting any other leaves the view untouched, and
the menu stays open either way so several can go in one visit. `smoke.mjs` drives `.chat-row`, not `.options` — a
picker rewritten back into a `<select>` would fail there first.

**An attachment chip is labelled `parent/name`, not by basename.** Half the folders worth attaching are called `src`,
`test` or `docs`; two of them side by side would be one label written twice, and the delete button next to it would be
a guess. The full path is the tooltip — a chip wide enough to show it would fit one item. The chips row wraps rather
than scrolling sideways, because an attachment scrolled out of view is one the user cannot see to remove.

**An attachment is folded into the transcript once, not re-sent every turn.** `Attachments` is a pending list that
`send()` empties into one `tool` message ahead of the user's words. Held outside the transcript and prepended to every
prompt instead, the same folder would go over the wire five times in five turns — and would sit outside compaction,
which is the only thing that can shrink it once the conversation grows. Half the prompt budget is the attachment's; the
other half has to hold the conversation it is for.

**Attachment paths are not confined to the home directory, and `readfile.mjs` paths still are.** The difference is who
named the path: a model naming one is a request to be vetted, a person picking one through a file dialog or dropping it
on the window has already decided. A project checked out on another drive is ordinary. `SECRET_DIRS` applies to both —
"I dragged the wrong folder in" is a mistake worth catching whoever made it.

**The listing is the part of an attachment that is never dropped.** It is the cheapest thing in there and the most
useful: "what shape is this project" is answerable from names alone, and a model shown the tree can ask for a file it
wants. File bodies fill the remaining budget in usefulness order — README and manifest first, then shallow before deep
and small before large — and what did not fit is named as not having fitted, so the model can tell "there is no more"
from "there is more I have not seen". The first body goes in even when it alone blows the budget: a single dropped file
rendering to its own filename and nothing else is indistinguishable from a bug.

**An attachment turn is drawn folded.** It is the one message whose size the user chose rather than the model, and a
dropped project renders to thousands of lines — a transcript with the reply somewhere below all of them is unusable.
The full text stays one click away, because what was sent to the model is what the user must be able to check.

**`isFirstTurn` counts user messages, not messages.** An attachment goes in ahead of the prompt, so a conversation
started by dropping a folder would otherwise never be named. `#retitle` skips `tool` messages for the same reason:
titling a chat from a directory listing yields "src, main, agent" for a conversation that was about something else.

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

**Detecting an element by selector and then clicking it by label is not sound, and must not be reintroduced.** The
engine offers both, but nothing ties them together: the label is re-resolved by the scorer and may land on a different
element. The YouTube ad skipper was built this way and withdrawn — on a page where an ad overlays the player it clicked
the ad, opening the advertiser in a new tab every 2.5 seconds. A convenience whose failure mode is worse than the
problem it solves does not ship. Doing it properly needs a click-by-selector command in the engine.

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

**Download speed is measured from deltas over a trailing window, never `received / elapsed`.** That formula is wrong
twice. On a **resumed** transfer `received` starts at whatever was already on disk, so a download resuming at 3 GB
reports gigabytes per second in its first seconds — yesterday's bytes credited to today. And as an average it lags: a
transfer that ran fast for a minute and then stalled goes on quoting the fast figure long after. `RateMeter` takes the
first sample as a baseline and reads the delta across the last 5 seconds, so neither can happen; a window with nothing
in it reports 0 rather than the speed it used to manage. `eta()` returns **null**, not a guess, when there is no total
or no measured rate — "0s left" on the first chunk reads as a finished download, and the renderer leaves both fields
out entirely until they can be stated.

**Progress is reported four times a second, not once per chunk.** Chunks land hundreds of times a second; every one of
them was an IPC message and a re-render, for a speed figure no one can read as it flickers.

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

When a fix is for something a user reported, the test should reproduce *their* case, not a tidy abstraction of it. The
numbers in `gpu.test.mjs` are a 25 GB model on a 12 GB card because that is what failed; the log excerpt in
`failure.test.mjs` is verbatim from the crash it explains.

**Probes that spawn a model or a browser must clean up on the way out.** One killed by a `timeout` left an orphaned
llama-server holding port 8080, and the app then reported a model as loaded while talking to it — a wrong answer that
looked exactly like a right one. Trap the signals, or use a different port.
