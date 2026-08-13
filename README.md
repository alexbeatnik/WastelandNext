# Wasteland Next

**A local LLM terminal that can drive your browser.** Amber-on-black CRT interface, Electron, no cloud required.

Wasteland Next is the [Wasteland Terminal](https://github.com/alexbeatnik/wasteland) interface rebuilt on Electron, with
the browser-control pipeline from [OS-Manul](https://github.com/alexbeatnik/OS-MANUL) and the
[manul-browser](https://github.com/alexbeatnik/manul-browser) engine underneath it. The look is the original's; the
security architecture is not — there is no seccomp lockdown, no encrypted chat store, no sandboxed executor. What
replaces them is a browser the model can actually use.

## What it does

Type a request. The model answers, or emits a fenced action block and the app carries it out:

| Action | What happens |
|---|---|
| `browser_steps` | Runs manul-browser DSL against your visible Chrome — navigate, click, fill, press, scroll |
| `browser_close` | Shuts the controlled browser down |
| `web_lookup` | A silent search in a **separate headless browser**, so your open tab is untouched |
| `read_file` | Reads one file, read-only, inside your home directory |
| `system_shell` | Runs a shell command — but only after you approve it in a dialog |

The browser is always one the app launches itself; there is no attach-to-your-own-Chrome mode, so a failure can never
look like the app meddling with tabs you were using.

Each capability has its own toggle in the left panel. A disabled capability is left out of the system prompt entirely
rather than described and then refused, so the model does not reach for tools it cannot have.

After a browser batch the page is scanned and its real labels are fed back, so the next step targets text that is
actually on screen instead of a guess. A title that is not on screen yet takes two turns by design: search on the
first, click an exact result on the second. The model is told that in so many words, with the search-and-stop shape
written out, because "never use positional targets" on its own leaves it choosing between guessing and refusing.

Replies are rendered as markdown — headings, lists, links, emphasis, inline code and code blocks. The original forbade
it because Nuklear drew glyphs rather than documents, so `**bold**` reached the user as four asterisks; this view can
draw it, so the model is allowed to use it. The text is parsed into plain data and built into DOM nodes, never assigned
as HTML, so a reply that happens to contain markup is displayed rather than executed.

**Thinking** is off by default and toggled beside the composer. Off, the model is asked to skip reasoning in the two
ways that work — a hard budget and the chat template's own flag — and whatever still arrives is hidden. It is shown
anyway when there is no answer to show instead, since an empty turn tells you nothing. Reasoning is stored with the
reply but never sent back on the next turn: a model re-reads its own deliberation as settled fact, and on a small
window the deliberation dwarfs the answer.

## Putting a file or a folder in front of it

`[ + FILE ]` and `[ + DIR ]` sit above the composer, and anything dropped on the window is attached the same way. Chips
show what is waiting — `DIR  GitHub/WastelandNext  148 files · 2.1 MB` — each with its own `×`, and the whole path on
hover. The question this is for is "here is my project, what would you improve": there is no agent mode, so the model
reads and answers in the chat rather than editing anything.

A folder arrives as a listing the model can reason about. `node_modules`, `.git`, `dist`, `venv` and the rest of the
usual build output are skipped; binaries are named with their size but never pasted, detected by a NUL byte in the
first kilobyte rather than by extension. Symlinks are not followed.

The listing is the part that is never dropped, because what shape a project has is answerable from names alone, and a
model shown the tree can ask for a file by name. File bodies fill whatever budget is left — README and manifest first,
then shallow before deep and small before large — and whatever did not fit is named as not having fitted, so the model
can tell "there is no more" from "there is more I have not seen".

Attachments go into the transcript **once**, as a message ahead of the words they came with, and are drawn folded there
— a dropped project is thousands of lines, and a transcript with the reply somewhere underneath is unusable. One click
opens it, because what was sent to the model is what you should be able to check.

Unlike `read_file`, an attachment is not confined to your home directory: a model naming a path is a request to be
vetted, but you picking one through a dialog have already decided, and a checkout on another drive is ordinary. The
credential directories — `.ssh`, `.aws`, `.gnupg` and friends — are refused either way.

## Requirements

| Component | Why | How |
|---|---|---|
| Node ≥ 22 | build and run | [nodejs.org](https://nodejs.org) |
| Go ≥ 1.26 | builds the engine | [go.dev](https://go.dev/dl/) |
| A [manul-browser](https://github.com/alexbeatnik/manul-browser) checkout | engine source + Node binding | clone it **beside this repo** |
| Google Chrome | what the engine drives | system install |
| `llama-server` | local inference | **downloaded on first model load** — or supply your own on `PATH` |

Only Node is needed to start the app. Without Go and the manul-browser checkout you get chat but no browser control;
without `llama-server` you can still point the app at any OpenAI-compatible endpoint.

## Install

```bash
git clone https://github.com/alexbeatnik/manul-browser   # beside this repo
git clone <this repo> WastelandNext
cd WastelandNext
npm install          # also builds the engine into resources/bin
npm start
```

`npm install` runs `scripts/build-manul-browser.mjs`, which stages **both halves** of manul-browser into `resources/`:

```
resources/bin/manul.exe      the Go engine, built from the checkout's core/
resources/manul-browser/     the Node binding's compiled dist, copied
```

The binary keeps manul-browser's own CLI name (`manul`) — that is what its binding looks for.

The checkout is found by looking for a sibling directory named `manul-browser` (then `Manul`, then `ManulEngineGo`,
which are what older local clones were called). `MANUL_SOURCE` overrides the search and may name either the repository
root or the `core` directory inside it.

There is deliberately **no npm dependency** on `manul-browser`: the package publishes no platform packages yet, and a
`file:` dependency would have to hard-code one directory name that npm resolves before any script could correct it. The
binding is loaded by path at runtime instead — and an installed `manul-browser` package still wins if one ever exists, so
this keeps working the day it is published.

A developer working on the engine can set `MANUL_BINARY` to their own build; the app leaves that override alone.

## Building a Windows executable

```bash
npm run dist
```

Stages manul-browser, then runs electron-builder. Two artifacts land in `dist/`:

| File | What it is |
|---|---|
| `WastelandNext-0.1.0-portable.exe` | ~75 MB, single self-contained file, runs with no install |
| `WastelandNext-0.1.0-setup.exe` | ~76 MB installer, per-user, installation directory selectable |

`dist/win-unpacked/` holds the same app as a plain directory, which is the quickest thing to debug against.

The packaged app carries the engine and the binding in its own `resources/`, so it needs neither the checkout nor Go on
the machine that runs it. It still needs Chrome for browser control and `llama-server` (or a remote endpoint) for
inference. The build is unsigned — Windows SmartScreen will warn on first run.

## First run

1. **FIND A MODEL** — type what you want (`qwen 7b instruct`, `gemma`, `coder`) and press `[ FIND ]`. Results are GGUF
   repositories ordered by downloads; click one to see its quantisations with real sizes — `Q4_K_M · 4.4 GB` — and
   `[ GET ]` the one you want. Multi-part shards are left out, with a note saying why: one download cannot assemble them.

   If you already know what you want, paste a repo id or a HuggingFace URL instead and press `[ DOWNLOAD ]`: that path
   picks the best single-file quantisation on offer (Q4_K_M first) and rewrites a `/blob/main/` URL from the address bar.

   Progress reads `model.gguf — 25.0% · 1.0 GB / 4.0 GB · 5.5 MB/s · 4m 0s left`. The speed is measured across a
   trailing five-second window rather than averaged over the transfer, so it follows what the connection is doing now,
   and a **resumed** download does not credit the bytes already on disk to this session. Neither figure is shown until
   it can be stated: "0 B/s, 0s left" on the first chunk reads as a stalled download rather than a starting one. An
   interrupted transfer keeps its `.part` file and resumes from it; one that goes silent for 90 seconds is abandoned,
   because only one runs at a time and a dead connection would otherwise refuse every later attempt as busy.

2. **LOCAL VAULT** — `[ LOAD ]` spawns `llama-server` against the file. The status bar turns green when it is ready.
   If no `llama-server` exists anywhere, it is downloaded first: the newest llama.cpp release for this platform
   (the Vulkan build on Windows and Linux, so the GPU is used without a CUDA toolkit), unpacked into the app's data
   directory. **INFERENCE → LLAMA-SERVER** shows what was found and can fetch it on demand. A binary you configured
   yourself, or one already on `PATH`, is always preferred — nothing is downloaded over your own install.

   **Already have models on disk?** `[ OPEN FILE… ]` takes a `.gguf` from anywhere — another drive, a folder shared with
   LM Studio or Ollama. The file is **referenced, never copied**: it stays where it is, and its row is marked `↗`.
   Removing such a row (`⊘`) forgets it and leaves the file alone; only files this app downloaded get a `×` that
   deletes. If the drive is unplugged the row stays, struck through and marked missing, rather than vanishing as though
   you had never added it.
3. Type. `Enter` sends; `Shift+Enter` inserts a newline.

Conversations live in a picker directly above the transcript — the list belongs next to the thing it selects, not at
the bottom of a settings rail. Clicking it opens the list, and **every row carries its own delete**, so a conversation
can be thrown away without being opened first. Deleting the one on screen clears the transcript with it; deleting any
other leaves the view exactly where it was, and the menu stays open so several can go in one visit. A chat is created
lazily on the first message, so a fresh one shows as `— new conversation —` until it has something to be named after.

## Context sizing

**INFERENCE → N_CTX** defaults to **AUTO**, which reads the model's own GGUF header instead of guessing from file size.
File size cannot answer the question: two 4 GB models can differ tenfold in KV-cache cost per token depending on layer
count and grouped-query attention, and one may have been trained for 4096 tokens while the other handles 128k.

Three limits apply and the smallest wins:

1. **the model's trained context** — a hard cap; exceeding it degrades output;
2. **memory** — 75 % of system RAM, less the weights and compute overhead, divided by the KV cost per token;
3. **a 32768 ceiling** — so a small model on a large machine does not reserve gigabytes of cache nobody asked for.

The panel shows what was chosen and why, e.g. `limited by model maximum · model max 32768 · KV 29.3 KB/token`.

Turning AUTO off hands the slider back and the value is passed through exactly as set — including one the model cannot
honour. An explicit setting that gets silently overridden is worse than one that fails loudly.

## Staying inside the window

The window holds the prompt **and** the reply, so the prompt is budgeted against `n_ctx` less a reserve. Measuring the
prompt against the whole window says a conversation is fine right up to the point where there is nothing left to answer
with: a real session reached 4594 of 4608, which is 99 % full and fourteen tokens from silence — the model emitted a
few words and stopped mid-sentence, which reads as the app cutting it off.

The meter above the composer shows the estimate, and three things keep it under control:

- **Compaction.** Everything older than the last two exchanges is summarised into one note. It is checked before every
  model call, not only at the start of a turn, because a browsing turn grows its own history — each batch appends a
  page map — and three follow-ups can cross the window with nobody having typed anything. `[ COMPACT ]` forces it.
- **A backstop.** Compaction keeps four messages verbatim, and one pasted README in that tail can fill a small window
  on its own — so it can run, succeed, and leave the prompt still over the line. When that happens the oldest messages
  are dropped and, if the newest is oversized by itself, cut from the middle so a pasted document keeps both what it is
  and the question appended underneath. The system prompt and the newest message always survive. Without this the
  oversized prompt simply went out and llama.cpp chose what to lose.
- **Reasoning is not resent.** It is kept in the transcript and dimmed in the view, but stripped on the way to the
  model. On a 4608-token window a thinking model filled the context in two turns, almost entirely with deliberation it
  had already finished with.

The token count is an estimate — the endpoint only reports real usage after the fact — and it counts Latin and Cyrillic
separately, at roughly 3.6 and 1.6 characters to the token. A single ratio for both undercounted a Ukrainian
conversation by about half: the meter read 99 % while the prompt was already over the window and llama.cpp was quietly
discarding the oldest part of it, which is what "it loses the thread" turned out to be.

## GPU offload

**INFERENCE → GPU LAYERS** is **AUTO** as well. Asking for every layer (`-ngl 999`) is right whenever the model fits and
fatal when it does not: llama.cpp allocates until the driver refuses and then exits, which arrives as a load that simply
failed. Partial offload is well supported, so the useful question is how many layers fit, not whether all of them do.

The card's memory is measured (`nvidia-smi`), the KV cache for the chosen context is subtracted, and the rest is divided
by the per-layer size. A 25 GB model on a 12 GB card becomes `15 of 52 layers fit in VRAM; the rest run on the CPU` —
slower than full offload, but it runs, where before it did not.

**With both AUTOs on, the context is traded down to keep the whole model on the card.** A layer left on the CPU is paid
on every token, so full offload at a shorter context beats a long context with part of the model on the processor. On a
12 GB card, Qwen3.5-9B (8.2 GB weights, an unusually expensive 128 KB/token of KV) is loaded at 15360 rather than 32768:

| | context | layers on GPU | measured |
|---|---|---|---|
| context traded down | 15360 | all 32 | **61.4 tok/s** |
| context pinned at 32768 | 32768 | 23 of 32 | 18.5 tok/s |

The context row says `reduced to keep every layer on the GPU` when this applies. It is only ever a reduction, and it is
skipped when the weights alone cannot fit — a 25 GB model on a 12 GB card has nothing to trade.

It also never goes **below 8192**. That floor was 4096, and a 12 GB card duly settled on 4608 — which this app cannot
live in. The system prompt, a page map and one pasted document come to a few thousand tokens before the user has said
anything, so the conversation was past the window by its second turn, and every reply after that was answered from a
prompt llama.cpp had already truncated. Three times the tokens per second is not worth a model that forgets what it
was asked.

Pin N_CTX by turning its AUTO off if you would rather have the longer window.

Only NVIDIA is probed. Windows' `AdapterRAM` reports 4 GB for anything larger, which is worse than no answer, so on other
cards the offload is left as configured. Turning AUTO off hands the slider back.

To use something already running instead — Ollama, LM Studio, a remote endpoint — put its base URL in
**INFERENCE → EXTERNAL ENDPOINT**. It takes precedence over anything local, and the context meter uses the window that
endpoint reports rather than the local setting.

## The interface

The layout picks its shape from the window's **aspect ratio**, not its width alone: a 1280×1024 4:3 panel and a
2560×1080 ultrawide report similar widths but want completely different layouts.

| Shape | Layout |
|---|---|
| 4:3 and taller | Two columns, narrower rail, tighter padding — vertical space is the scarce resource |
| 16:10 and wider, ≥ 1500px | Three columns: rail, chat, and a live activity log; chat capped at 90ch so lines stay readable |
| Under 900px wide | One column; the rail becomes an overlay drawer |

`npm run smoke` boots the real window offscreen and asserts all of this — every shape resized, no horizontal overflow,
the activity column present exactly where it should be.

`[ ABOUT ]` in the top bar opens a box with the build's version, a five-step quick start, and links to the repository,
the releases page, the author and the licence. The links open in your real browser rather than navigating this window.

## Project layout

```
src/
├── main/                   Electron main process
│   ├── main.mjs            window, lifecycle, child-process teardown
│   ├── ipc.mjs             every main↔renderer channel
│   ├── config.mjs          persisted settings
│   ├── chats.mjs           one JSON file per chat
│   ├── paths.mjs           data root, injected at boot so the rest stays testable
│   ├── llm/
│   │   ├── server.mjs      llama-server child process
│   │   ├── client.mjs      OpenAI-compatible streaming, endpoint-agnostic
│   │   ├── tools.mjs       fetching llama-server when there is none
│   │   ├── gguf.mjs        model header parsing + context sizing
│   │   ├── gpu.mjs         VRAM detection, layer fitting, context trade
│   │   ├── failure.mjs     turning a crash log into a sentence
│   │   └── port.mjs        refusing to start onto an occupied port
│   ├── models/
│   │   ├── manager.mjs     vault scan, HuggingFace resolve, resumable download
│   │   ├── rate.mjs        download speed and time remaining
│   │   ├── search.mjs      in-app model search + per-repo file listing
│   │   └── placement.mjs   where a model would run, before it is loaded
│   ├── browser/
│   │   └── manul-browser.mjs  the manul-browser bridge
│   └── agent/
│       ├── agent.mjs       the turn pipeline, compaction, window budgeting
│       ├── attach.mjs      files and folders the user put in front of the model
│       ├── actions.mjs     reading actions out of a reply
│       ├── batch-guard.mjs refusing a browser batch identical to one already run
│       ├── prompts.mjs     the system prompt, assembled per capability
│       └── readfile.mjs    the read-only file path
├── preload/preload.cjs     the renderer's whole view of main
├── renderer/               index.html · styles.css · app.js
└── shared/
    ├── render.mjs          text shaping both processes need
    ├── markdown.mjs        markdown → data the renderer builds nodes from
    └── engine.mjs          finding the manul-browser checkout
```

## Testing

```bash
npm test       # 288 unit tests, no Electron, no network
npm run smoke  # boots the real window offscreen and checks the UI and layout
```

`npm test` covers the pure logic: action extraction and its JSON repair, `<think>` splitting and stripping, markdown
parsing, chat storage and id validation, path vetting, HuggingFace URL rewriting and quantisation choice, prompt
assembly, GGUF header parsing and the context/GPU arithmetic, the compaction threshold and the window backstop, folder
collection and its budget, download speed and resume, crash-log summarising, checkout resolution, and where a
*packaged* app looks for the engine.

`npm run smoke` boots the real window offscreen — 83 checks — and covers what unit tests cannot: a renderer that throws
on boot, a preload that failed to expose its bridge, an IPC channel renamed on one side only, a layout that breaks at
one screen shape, or a control that stops resetting what it should. It clicks NEW CHAT, presses Enter, attaches a
folder and detaches one of two, deletes a conversation from the picker without opening it, opens the About box and
checks every link in it would leave the window, resizes through seven screen shapes, and checks that a reply containing
`<img onerror=…>` is drawn as text rather than run.

Where a fix is for something a user reported, the test reproduces *their* case rather than a tidy abstraction of it:
the numbers in the GPU tests are a 25 GB model on a 12 GB card, the context tests use 4594 of 4608, and the crash-log
excerpt is verbatim from the failure it explains.

Two checks are worth singling out, because both passed while the thing they covered was wrong.

The first read an element's `hidden` attribute, found it set, and passed — while the element sat visible on screen the
whole time, because `hidden` is only the UA rule `[hidden] { display: none }` and any author-level `display` outranks
it. Visibility is asserted through `getComputedStyle` now: what the attribute says and what the user sees are
different questions.

The second asserted that the About box showed a version-shaped string, and passed on `Version 34.5.8` — Electron's
version, not this app's, because `app.getVersion()` falls back to it when it cannot find the app manifest, which is
precisely what running the smoke script does. The version is read from `package.json` directly now, and the check
compares against that same manifest rather than against a pattern.

## How it differs from the original

| | Wasteland | Wasteland Next |
|---|---|---|
| Language | C11 + Nuklear + SDL2 | Electron |
| Inference | llama.cpp linked in | `llama-server` subprocess, OpenAI-compatible |
| Network | seccomp kills any new socket after load | open — the browser needs it |
| Chat store | XChaCha20-Poly1305 | plain JSON |
| Agent | sandboxed filesystem tools | browser control, lookup, read-only file, gated shell |
| Context | fixed window, no compaction | budgeted against the reply, compacted, with a hard backstop |
| Layout | fixed panels | aspect-ratio responsive |
| Replies | plain text — Nuklear drew glyphs, not documents | markdown, parsed to data and built as DOM nodes |
| Context / offload | fixed `N_CTX`, `-ngl` as set | sized from the model header and the card |

## Known gaps

- The engine and binding come from a sibling checkout rather than from npm — `manul-browser` has no published platform
  packages yet, so there is nowhere else for either to come from.
- `web_lookup` reads DuckDuckGo result text. It has no AI-overview extraction and no CAPTCHA handling.
- VRAM is detected through `nvidia-smi` only. On an AMD or Intel card the offload is left exactly as configured, because
  a wrong number would be worse than none — Windows reports 4 GB for anything larger.
- Only Windows is packaged so far. macOS and Linux targets are a config change away but have not been built or tested.
- Builds are unsigned; there is no auto-update feed.
- Compaction is triggered by an estimated token count, not a real one — the endpoint only reports actual usage after
  the fact. The estimate counts Latin and Cyrillic separately (about 3.6 and 1.6 characters to the token), because one
  ratio for both undercounted a Ukrainian conversation by roughly half.
- An attached folder is read once, at the moment it is sent. Nothing watches it afterwards, so a file edited later is
  the version the model first saw until you attach it again.
- There is no agent mode. The model reads what you attach and answers in the chat; it cannot edit or write anything.
- There is no automatic ad skipping. It was built and withdrawn: the engine can find an element by CSS selector and it
  can click one by its visible label, but it cannot click *the element the selector found*. On a page where an ad
  overlays the player, the label resolved to the ad instead of the skip button and opened the advertiser in a new tab,
  repeatedly. Doing this properly needs a click-by-selector primitive in the engine.

## License

[Apache License 2.0](LICENSE) — the same licence as
[manul-browser](https://github.com/alexbeatnik/manul-browser), whose engine and binding this ships.
