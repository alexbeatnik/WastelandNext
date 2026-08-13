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

Each capability has its own toggle in the left panel. A disabled capability is left out of the system prompt entirely
rather than described and then refused, so the model does not reach for tools it cannot have.

After a browser batch the page is scanned and its real labels are fed back, so the next step targets text that is
actually on screen instead of a guess.

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

## GPU offload

**INFERENCE → GPU LAYERS** is **AUTO** as well. Asking for every layer (`-ngl 999`) is right whenever the model fits and
fatal when it does not: llama.cpp allocates until the driver refuses and then exits, which arrives as a load that simply
failed. Partial offload is well supported, so the useful question is how many layers fit, not whether all of them do.

The card's memory is measured (`nvidia-smi`), the KV cache for the chosen context is subtracted, and the rest is divided
by the per-layer size. A 25 GB model on a 12 GB card becomes `15 of 52 layers fit in VRAM; the rest run on the CPU` —
slower than full offload, but it runs, where before it did not.

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
│   │   └── gguf.mjs        model header parsing + context sizing
│   ├── models/
│   │   ├── manager.mjs     vault scan, HuggingFace resolve + download
│   │   └── search.mjs      in-app model search + per-repo file listing
│   ├── browser/manul-browser.mjs   the manul-browser bridge
│   └── agent/
│       ├── agent.mjs       the turn pipeline
│       ├── actions.mjs     reading actions out of a reply
│       ├── prompts.mjs     the system prompt, assembled per capability
│       └── readfile.mjs    the read-only file path
├── preload/preload.cjs     the renderer's whole view of main
├── renderer/               index.html · styles.css · app.js
└── shared/
    ├── render.mjs          text shaping both processes need
    └── engine.mjs          finding the manul-browser checkout
```

## Testing

```bash
npm test       # 198 unit tests, no Electron, no network
npm run smoke  # boots the real window offscreen and checks the UI and layout
```

`npm test` covers the pure logic — action extraction and JSON repair, `<think>` splitting, chat storage, path vetting,
HuggingFace URL rewriting, quantisation choice, prompt assembly, checkout resolution, and where a *packaged* app looks
for the engine, and which release asset to fetch. `npm run smoke` covers what unit tests cannot: a renderer that throws
on boot, a preload that failed to expose its bridge, an IPC channel renamed on one side only, a layout that breaks on a
particular screen shape, or a chat control that stops resetting what it should — it clicks NEW CHAT and presses Enter
for real.

## How it differs from the original

| | Wasteland | Wasteland Next |
|---|---|---|
| Language | C11 + Nuklear + SDL2 | Electron |
| Inference | llama.cpp linked in | `llama-server` subprocess, OpenAI-compatible |
| Network | seccomp kills any new socket after load | open — the browser needs it |
| Chat store | XChaCha20-Poly1305 | plain JSON |
| Agent | sandboxed filesystem tools | browser control, lookup, read-only file, gated shell |
| Layout | fixed panels | aspect-ratio responsive |

## Known gaps

- The engine and binding come from a sibling checkout rather than from npm — `manul-browser` has no published platform
  packages yet, so there is nowhere else for either to come from.
- `web_lookup` reads DuckDuckGo result text. It has no AI-overview extraction and no CAPTCHA handling.
- Only Windows is packaged so far. macOS and Linux targets are a config change away but have not been built or tested.
- Builds are unsigned; there is no auto-update feed.
- Compaction is triggered by an estimated token count, not a real one, until the endpoint reports usage.

## License

[Apache License 2.0](LICENSE) — the same licence as
[manul-browser](https://github.com/alexbeatnik/manul-browser), whose engine and binding this ships.
