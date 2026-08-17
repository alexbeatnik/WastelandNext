# Working notes

Invariants and traps for anyone — human or agent — changing this codebase.

## Shape of the thing

Electron. Main process owns all state; the renderer owns none. Every asynchronous fact reaches the renderer on **one**
IPC channel (`event`) as `{event, ...payload}`, and every request is an `invoke` returning `{ok, value|error}` which
`preload.cjs` unwraps. Adding an event type needs no change to `ipc.mjs` or `preload.cjs` — only a `case` in the
renderer's `handleEvent`.

The renderer holding no pipeline state is deliberate: a reload can never leave the two disagreeing about whether a turn
is running.

## Plugins

Everything the model may *do* is a plugin. `PluginHost` in `plugins/host.mjs` is the registry; `agent.mjs` no longer
knows that a browser exists. A plugin contributes exactly four things — action handlers, the slice of the system prompt
documenting them, context recomputed each turn, and a hook run once per user message — and reaches the app only through
services it named in its manifest and the host handed it by name.

**The prompt fragment and the handler ship together, in one activation.** That pairing used to be four checkboxes and a
`switch`, held in step by hand. It is now impossible to register an action without its documentation or document one
that will not dispatch, and `plugins.test.mjs` asserts the two sets are equal against the real built-ins. This is what
the whole indirection is for; do not add an action type to `prompts.mjs`.

**A prompt fragment must name the refusal it exists to prevent.** Describing the action accurately is not enough:
`audio-player`'s first fragment did exactly that and never said "I can't play music" was false, and the first request
to play a song got "I can't directly play music. However, I can search for it on YouTube" — from a model holding
`play_music`. That is the same failure as answering "I have no access to real-time information" with `web_lookup` in
hand, and the same cure applies. It is worse inside this app than most, because `BROWSER` is long, prescriptive and
carries a worked example of playing a song on YouTube; a fragment that does not push back is competing with that.

**Built-ins are imported statically from `src/plugins/index.mjs`, never discovered on disk.** They are part of the
build, so there is nothing to discover — and a packaged app keeps `src/` inside `app.asar`, where whether a dynamic
import resolves is a question worth not having to answer. Only installed plugins, which live on the ordinary
filesystem under the data root, are imported by path.

**A manifest is untrusted input.** It arrives inside an archive from a repository we do not control. The id becomes a
directory name *and* a key in `config.plugins`, so it is validated for the same reason `isSafeId` exists in
`chats.mjs`; `main` is checked with the same question `assertSafeArchive` asks of an archive entry, backslash counted
as a separator. A manifest naming an `apiVersion` this build does not implement is listed with "update Wasteland Next"
rather than loaded — a plugin failing somewhere inside `activate` on a function that does not exist yet is the same
bug as a pinned llama.cpp tag that predates a flag.

**A plugin present on disk is not an instruction to run it.** `approved` is recorded when the user switches an
installed plugin on, and that click is the consent — the warning sits on the row being clicked. A directory that
appeared in `plugins/` runs nothing until then. Built-ins are approved by shipping inside the application.

**Half a plugin is worse than none.** Contributions are collected during `activate` and committed only once it has
returned: one that registers two actions and throws between them would otherwise leave the model holding an action
whose other half never arrived.

**An action type can be claimed once, and built-ins are activated first.** Quietly letting a newcomer shadow
`system_shell` is how an action stops meaning what the prompt says it means. The second claimant is refused with a
reason on its row.

**A switched-off plugin's action types are still known.** `owner()` reads them from the manifest without loading
anything, so the dispatcher answers "Browser control is switched off" instead of "unknown action type". The difference
is not cosmetic: told the second, a model retries with different spelling; told the first, it tells the user.

**Nothing a plugin does may end a turn.** A handler that throws produces feedback the model can act on, exactly as one
returning a failure does. Without that, a third-party typo leaves the transcript with a blinking cursor and no reply —
which is the same failure `reply:start` owing a `reply:end` exists to prevent.

**The approval dialog belongs to the turn, not to the plugin.** `turn.confirm` is what `system-shell` calls; the
pending map, the `shell:request`/`shell:resolved` events and the answer from Stop all stay in `agent.mjs`. A plugin
that wanted to skip the dialog would only have to not call anything, so the question cannot live on its side.

**The old `allow*` keys are read exactly once, and only when all of them are present.** They are gone from `DEFAULTS`,
so a fresh install has none — and reading an absent key as `false` would ship with every capability disabled and no
hint why. `mergeEnablement` also never overrules an id already recorded: rediscovery on the next boot must not undo
what the user chose.

**A theme pack has no code, and that is the whole consent model.** `main` is optional in a manifest; a plugin without
one contributes only what the app reads itself — stylesheets, an icon — so there is nothing to approve and the
approval step keeps meaning something. `needsApproval` is the single place that decides, and a manifest declaring
actions or services with no entry point is refused rather than listed as working while doing nothing.

**The custom schemes must be registered before `app.whenReady()`**, which is why `registerSchemes()` sits at module
scope in `main.mjs` and in `smoke.mjs`. Registered late, a scheme is an ordinary opaque one: no `stream: true`, no
Range support, and a seek in a long track silently does nothing. `serveProtocols` — the handlers — can only be
installed after ready, so the two halves are deliberately separate calls.

**`wasteland-plugin:` is the only way a theme can exist.** `style-src 'self'` on a `file://` page rejects an inline
`<style>` built from IPC text *and* a stylesheet in another directory. Both are named in the CSP in `index.html`;
`script-src` stays `'self'` alone, because no plugin runs code in that window. A theme therefore arrives as a `<link>`
pointed at our own handler, which serves nothing outside one plugin's directory.

**`shared/schemes.mjs` exists because `protocol.mjs` imports `electron`.** The first version put the URL builders
beside the handler, and `host.mjs` importing one of them took the whole plugin test suite down with
`does not provide an export named 'protocol'` — the same lesson `classifyError` records, learned again. Anything both
processes need must not live in a file that imports `electron`.

**The audio service is not a music player, and must not become one.** It knows one source, whether it is playing, how
loud, and what to write on the bar. The queue, shuffle, repeat, the library and what "next" means all belong to the
plugin, which registers a transport the app asks. That is what lets a second plugin drive the same bar, and what keeps
a plugin that plays one notification sound from inheriting a next button it cannot honour. The bar's buttons come from
the transport's own list, so an undeclared one is never drawn.

**The media scheme reaches anywhere on disk, so the allowlist is the one file that is loaded.** Not the queue — the app
does not have the queue — and not "is the path well formed". `audio.allows` answers exactly "did we put this in front
of the user", and `clear()` revokes it.

**The renderer never builds a media URL.** `status().source.src` is built in the main process, because the scheme and
its encoding belong to the handler that takes them apart again — a second encoder is a second thing to get wrong about
a filename containing `#`, which ends a path and starts a fragment.

**`.player[hidden]` is not optional.** The bar is `display: flex`, and any author-level `display` outranks the UA rule
behind `hidden` — the drop veil shipped visible for exactly this reason. The smoke check reads `getComputedStyle`.

**A registry icon is a data URI or nothing.** The page allows `img-src data:` and no remote host, so a linked icon
would both fail to draw and turn opening the plugin list into a request telling somebody who opened it. `parseEntry`
drops anything that is not `data:image/`.

**An install is atomic, and a checksum is mandatory.** Fetch to scratch, compare the digest the index published, read
the archive's central directory without unpacking (`assertSafeArchive`), unpack to staging, validate the manifest, and
only then move it into `plugins/`. A half-unpacked directory would be discovered on the next boot and listed as a
broken plugin the user never installed. An entry with no `sha256` is refused outright: the index is the only thing
being trusted, and without a digest nothing ties it to the bytes.

**Versions are compared numerically, in two places.** `1.10.0` is newer than `1.9.0`, which a string comparison gets
backwards — and an update button that never appears is indistinguishable from a registry that never publishes. The
renderer has its own small copy because it decides which rows show UPDATE.

**Anything meant to be discovered must be on disk before `registerIpc`.** It is what starts `plugins.load()`. The smoke
runner writes its test theme first for that reason; the version that wrote it afterwards reported four plugins and a
theme picker with one entry, both truthfully.

**`#broken` carries every field `list()` reads.** A plugin that could not be understood is still a row on screen, and a
row that throws while being drawn takes the whole list with it.

**The `mic` service is the mirror of `audio`, and must stay as small.** Capture has to happen in the renderer, because
`getUserMedia` exists there and nowhere else, and no plugin runs code in that window — so the app owns the button, the
recording and the encoding to 16 kHz mono, and a plugin owns turning sound into words. It knows whether it is
listening, whether something is being transcribed, and who to hand the audio to; which model, which language and how
the words are extracted are the plugin's, which is what lets a second plugin drive the same button with a different
engine.

**The mic button is drawn only when a transcriber says it is `ready`.** Registered and ready are different facts:
the first means "this plugin drives dictation", the second means "there is a model on disk". A microphone that records
into nothing is a dead control, and the explanation belongs on the plugin's row, where a model can actually be
obtained.

**`hear()` deletes the recording in a `finally`, on every path.** This is a recording of somebody's voice. Leaving it
in a scratch directory because the engine threw is not litter; it is a recording of somebody's voice left on their
disk. The renderer stops every track the moment recording ends rather than when the transcript comes back, for the
same reason in a different register: the operating system's recording indicator stays lit until it does, and a
microphone that appears to still be listening while a model runs is alarming and untrue.

**Dictated text goes into the composer, never straight out.** What a speech model heard is exactly the thing worth
reading before it is sent. Voice input also contributes *nothing* to the system prompt — nothing the model can do
changes, since the text arrives as if typed, and describing a microphone it cannot operate would invite it to offer to
"listen".

**A `select` setting names its options in the manifest.** So the row can be drawn before a line of the plugin's code
has run, and so what a plugin may be set to stays readable without reading it. `setSetting` refuses a value that was
not offered: a row displaying a state the plugin has no code for is worse than a refused click, and the plugin reading
it back would be entitled to assume otherwise.

**`ctx.progress` draws on the plugin's own row, and the renderer keeps it in `state`.** The activity log is the wrong
place for a 1.5 GB download — it scrolls, the narrow layout hides that column, and a percentage that has to be hunted
for is one nobody watches. It is held in `state.pluginProgress` rather than left in the DOM because `paintPlugins`
rebuilds every row for reasons that have nothing to do with the download, and a meter that vanished because a setting
was saved mid-fetch looks like a download that stopped.

**`ctx.dataDir()` is outside the installed tree, like `ctx.state`.** That tree is deleted and replaced on every update,
so a speech model downloaded into it would be downloaded again on every version bump. `forgetData` removes both on
uninstall: a gigabyte of model outliving the plugin it belongs to is the largest thing in the data directory with
nothing on screen to explain it.

**`ctx.store` is the user's answers; `ctx.state` is the plugin's own.** Every `store` key is declared in the manifest
because every one of them is a control drawn on the plugin's row — a music folder, an endpoint. A list of reminders is
neither: nobody declares it, nobody types it into a field, and there is no row to draw it on. So a plugin also gets one
JSON document keyed by id, under `plugin-state/` rather than inside the plugin directory — that whole tree is deleted
and replaced on every update, which would make updating a plugin the thing that loses your reminders. It is written to
a temporary file and renamed over the target: a truncated JSON file reads back as `{}`, which is every reminder gone
with nothing anywhere saying so.

**A notice is the one message with no question in front of it.** Everything else this app says is an answer — the user
typed, a turn ran, a reply came back — and there was nowhere for a reminder to go: the transcript belongs to a
conversation, the status bar is overwritten by the next thing, and a plugin cannot reach the window. `notify.show`
goes two places at once, a card in the transcript and an OS notification, because neither is enough alone. It is
drawn as its own element rather than as an assistant turn: it did not come from the model, and dressing it as a reply
makes the model responsible for words it never wrote.

**Recent notices are kept, because one can be raised before the window is listening.** The plugin host starts before the
renderer has subscribed, and a reminder coming due during boot is exactly the case the feature exists for. They arrive
twice on purpose — in the snapshot and again on the stream — and the renderer skips an id it has already drawn.
`pluginName` is deliberately *not* on the notice: the name is resolved from the id where it is drawn, so a plugin
cannot sign a message with a name other than the one on its own row.

**A registry list is a widening of trust, and looks like one.** Adding one is a URL typed in and a button pressed;
nothing a page or a plugin can arrange. An index must be https — it is a list of URLs and checksums deciding what gets
downloaded and unpacked, and anything on the path could rewrite it — with loopback excepted, since there is no path to
sit on. Two registries publishing the same id is a fork or a mirror rather than an error, so the newest wins; what
makes that safe is that it is not silent, and the source label travels with the entry to the row.

**One registry failing must not empty the list, and *all* of them failing must not hide which were asked.** `fetchIndex`
reports per source and never throws: it returns `error` only when nothing answered, because throwing lost exactly the
thing worth showing in that state. Removing the broken registry is how the user gets the list back, and they cannot
remove a row that was never drawn. The boot fetch stays silent about a failure — the update badges are worth a
background request, an error about a list nobody asked to see is not — while the rows still say what happened.

**Installing from a local archive has no checksum, and that is not a gap.** A digest ties a download to the index that
offered it; a file picked in a dialog was offered by nobody, and the choice is the consent — the same distinction
`attach.mjs` draws between a path a model named and a path a person picked. Every other check still runs, including
`assertSafeArchive` and the manifest, and the code still cannot run until it is approved. The digest is computed and
handed back anyway, so somebody who *does* have a published hash can compare.

**Staging happens inside the data root, not in `tmpdir()`.** The last step of an install is a rename onto the data
root, and a rename across volumes fails with `EXDEV`. On a machine whose `TEMP` is on another drive that made every
install fail at the very end — after the download, the checksum and the unpacking had all worked.

**`paintPlugins` owns the section's status line.** It writes the active count, which is also how a previous error
message goes away; the first version of the toggle handler cleared the line immediately afterwards and blanked the
count it had just written. The smoke check asserts the number, not that the text changed — an empty string is
different from anything, so the weaker check passed on the bug.

**A scene is data, and the app draws it.** The `scene` service is the same bargain the audio bar struck: a plugin cannot run code in this window, so it holds the game and says what the panel *contains*, while every node on screen is built here from a document with a fixed set of keys. `normaliseScene` is where "whatever the plugin passed" becomes that document, and the reason it is strict is that most of what a game shows is model output at one remove — an item a language model named, a journal line it wrote, stored by the plugin on the way past and no more trustworthy for having been stored.

**`tone` is the only field that becomes a class name, so it is the only field taken from a list.** Everything else in a scene lands in a `textContent`, where the worst a hostile string can do is look silly. A tone passed through would let a plugin — or the model writing through it — name any class in the stylesheet.

**The app assigns the hotkeys, by position.** Two actions asking for the same key is a conflict with no good resolution, and a key that silently did nothing because something else had claimed it is indistinguishable from a broken button. The cost is that `3` means a different move after the list changes, which is true of the buttons themselves anyway.

**A digit typed into the composer is a digit.** The hotkey handler is on `document`, and the composer is where the game is played from — without the check for an input, a typed sentence would fire a move on every numeral in it, while the half-written message sat in the box. `isContentEditable` is tested as well as the tag name: an element can be an editing host without being an `<input>`. The smoke check types into the composer and asserts both that nothing was pressed and that the text is untouched; nothing in the source distinguishes the working handler from the broken one.

**A move is sent by the renderer, and `scene.act` only hands the words back.** A turn belongs to a conversation and the main process does not have a current one — the same fact `attach.mjs` records. Routing a pressed button back through the window that does know also means it goes down exactly the path typed text takes, so `submitPrompt` is shared and the busy check, the transcript entry and the hand-back on failure are not implemented twice. It is also the whole of what stops a game looping: nothing in the service can start a turn, so a move happens because a person pressed a key.

**`submitPrompt` gives the composer its text back only when the composer is where it came from.** A move made by pressing a button has nowhere to return to, and dropping the game's own phrasing into the box the player types in is worse than losing it.

**A game is played in a conversation, and the panel belongs there with it.** The first version tied the scene to nothing, so the strip and the row of moves were drawn over every chat in the app: opening a new conversation gave an empty transcript under a character sheet and a list of moves, offering a game that was not being played. `show()` stamps the scene with the conversation the turn is running in, `ipc.mjs` supplies that off `turn:start` because it is the only place that sees both, and the renderer draws nothing unless the open chat is that one. Both ids must be non-empty rather than merely equal — `state.chatId` is `''` on a new conversation, and "no chat" must not match "no game".

**A scene painted outside a turn claims no conversation, and one that claimed none is drawn nowhere.** Activation and timers both land there. Nothing outside a turn knows which chat a game is being played in, and taking "whichever is open" is exactly how the panel got everywhere in the first place. The cost is that a run reopened after a restart has no panel until the first move; that is a smaller wrong answer than a hero on screen for somebody who opened the app to ask about something else, and the run itself is never at risk — it is in the plugin's save, and `context()` hands it to the model whether or not anything is drawn.

**The hotkeys are hidden with the panel.** A digit answered by a panel the user cannot see would make a move in a conversation the game is not being played in. `sceneShowing()` is the single answer to "is this game on screen", and the keyboard, the sheet and the paint all ask it.

**A list row is a control only when the game gave it one.** An inventory is what `action` on an item exists for: putting the sword in your hand is a thing to do to a row, not a move to pick off a bar. It is optional because a journal is not an inventory, and an entry that could be clicked and did nothing would be worse than one that plainly cannot be. `#offered()` folds those ids in with the moves', so a stale click on a bag emptied three turns ago is refused exactly as a stale move is.

**`sheet: true` is the only way a plugin can open the dialog.** The sheet is the app's, so a game asking to "look in the bag" had no way to show one — an inventory button that only wrote a line in the status bar would be a control describing the thing it should have shown. It is honoured before `submit`, so a move that opens the bag *and* takes a turn shows the bag first rather than after the reply lands.

**A scene with no presenter offers no moves.** Same rule as the transport's button list: a driver that went away takes its buttons with it. What the hero looked like stays on screen — that is a readable end state — but a control that is drawn and cannot work is worse than one that is absent.

**A button that is not on screen cannot be pressed.** `act` refuses an id that is not in the current scene. A click carries an id the renderer read off a button, and a button can outlive the scene that drew it; a stale one firing a move in a world three turns further on is impossible to reproduce and easy to refuse.

**The game panel is inside the chat column, not a fourth grid column.** The workspace picks its column count by aspect ratio, and a 4:3 panel has two — a game needing the third would be unplayable on half the shapes the layout already supports. So the strip and the action row sit in the chat column and the lists go in a dialog, which costs the transcript some height: the smoke run checks a 900×700 window with a game up and asserts the log still has 200px, because that is the shape where it is paid for.

## Traps

**`ELECTRON_RUN_AS_NODE`.** VS Code's integrated terminal sets this. With it set, `npx electron .` runs the binary as
plain Node, `require('electron')` returns a *path string*, and you get a confusing `Cannot read properties of undefined`
in the ESM loader. `unset ELECTRON_RUN_AS_NODE` before launching from a VS Code terminal. This is not an app bug and no
amount of changing imports will fix it.

**Top-level `await app.whenReady()` deadlocks.** Electron holds the ready event until the ESM entry module finishes
evaluating. Use `app.whenReady().then(...)`, as `main.mjs` and `scripts/smoke.mjs` both do.

**Nothing constructed at module scope may read settings, because `setDataRoot` has not been called yet.** It is called
in `main.mjs`'s *body*, and an ESM import graph is evaluated in full before that body runs — so a singleton created
down in `ipc.mjs` resolves the platform default root rather than Electron's userData directory. `AudioOut` read the
stored volume in its constructor: the read missed a `config.json` that only exists under the real root, the defaults it
cached were what every later reader in the process got, and the first `config.update` then wrote those defaults over
the real file. What that looked like from outside was every plugin asking to be approved again on each launch, having
forgotten the music folder, the speech model and the language — settings that were sitting in `config.json`, correct,
the whole time. `PluginHost.#states()` defers `pluginStateDir()` for the same reason; do likewise, and read settings on
first ask. `config.mjs` now pins its cache to the path it was read from, so a root arriving late causes a re-read
rather than a permanent wrong answer — but that is a backstop, not a licence: whatever read early has already acted on
a default. `config.test.mjs` reproduces the reported case.

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

**Every extractor takes the entry names on trust.** bsdtar, GNU tar, `unzip` and `Expand-Archive` all write wherever
the archive tells them to, including `..\..\Windows\System32`, and the archive here arrives over the network — after
which we go looking inside it for a binary to spawn. `assertSafeArchive` in `llm/zip.mjs` reads the central directory
(two short reads at the end of the file; entry names live there, so nothing is unpacked and nothing is held in memory)
and refuses an absolute path, a drive letter or any `..` segment. Backslash counts as a separator even though the format
says otherwise: Windows extractors honour both. An archive whose directory cannot be parsed is refused too — a truncated
download and an HTML error page saved as a `.zip` both land there, and "could not check" is not a reason to unpack it
anyway.

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

**Naming any `files` entry in `electron-builder.yml` replaces the default `**/*`, and `node_modules` goes with it.** The
config lists `src/**/*`, `package.json` and `LICENSE`, so the first runtime dependency — `electron-updater` — was
simply absent from the package. It fails only when packaged, since a development run resolves it from the checkout, and
it fails at import time with `Cannot find module`. `node_modules/**/*` is listed explicitly now; electron-builder prunes
devDependencies itself, so that ships the updater and little else.

**`quitAndInstall` spawns the installer and only then asks the app to quit.** Everything this process owns must already
be gone: an orphaned llama-server keeps port 8080, and the *next* run then reports a model as loaded while talking to a
stranger — a wrong answer that looks exactly like a right one. The updater's `teardown` runs `shutdown()` and
`server.unload()` first, bounded at 8 s so a Chrome that will not close cannot hold an update hostage. Install is
silent (`quitAndInstall(true, true)`): the full NSIS wizard opens by asking the user to close an app the updater has
just closed for them.

**A repository with no releases is not an update failure.** electron-updater throws "No published versions" and
reporting that as an error sends the user hunting for a firewall that was never in the way. `classifyError` in
`shared/updates.mjs` maps it to `current`; it lives in `shared/` rather than beside the updater because `updater.mjs`
imports `electron` and therefore cannot be unit-tested at all.

**`app.getVersion()` answers with *Electron's* version when it cannot find the app manifest.** `electron
scripts/smoke.mjs` is exactly that case, so the About box read `Version 34.5.8` and the check — which only asserted a
version-shaped string — passed on it. `VERSION` in `ipc.mjs` parses our own `package.json` through a URL relative to
the module, which resolves inside `app.asar` too: this file is at `src/main/ipc.mjs` and the manifest at the archive
root, packaged or not. The smoke check compares against the manifest rather than against a shape, because a version
field confidently displaying the wrong number is worse than one that fails.

**Every link in the About box needs `target="_blank"`.** That is what routes it through `setWindowOpenHandler` into
`shell.openExternal`. Without it the chat window itself navigates to GitHub, and there is no way back — no address bar,
no back button. The smoke check asserts it on every anchor in the dialog, not just the first.

**`applyDictionary` must not write over text the app has since rewritten.** It walks markup captured at boot, and some
of that markup is written to later by code — the mic button's tooltip gains the name of whichever plugin is listening.
Putting the captured original back is not a translation, it is an erasure: the button spent a whole run saying
`Dictate` instead of `Dictate — Smoke ears`, with the main process reporting the right answer the entire time. A node
is skipped when what it holds is neither the string captured nor the one this function last wrote — both of those are
ours, anything else has an owner. Anything written dynamically therefore goes through `t()` instead, which is what the
function is for.

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

**"Look it up before saying you do not know" lives inside the lookup section, not in the base rules.** A model that
answers "I have no access to real-time information" while holding a search action is describing a session it is not in
— it did exactly that for the date, two messages after using the same action for the weather. The instruction names the
class (anything that moves with time: the date, weather, prices, scores, versions, who holds an office) rather than
listing questions, and it is part of `WEB_LOOKUP`, so a session with lookup switched off never sees it. `prompts.test.mjs`
asserts both halves — present with the capability, absent without it — because encouraging a tool that is not there is
the same bug as forbidding one that is.

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

**The conversation cannot be switched or deleted while a turn is running.** NEW CHAT, a row in the picker and both
delete buttons all refuse with a line in the status bar. The turn belongs to a chat the main process picked; switching
underneath it draws the reply into a conversation it does not belong to, and the finishing `send()` then sets the id
back to the one the user just left. The id itself comes from `turn:start`, not from the resolved `agent.send()` promise
— the same fact, but announced when it becomes true rather than minutes later.

**`loadChat` carries a sequence number.** `chats.read` is a round trip and two picks can be in flight at once; the
older one finishing second draws the previous transcript over the conversation the picker says is open. Every await
checks it is still the current load and drops out if it is not.

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

**An attachment is folded into a conversation once, and stays attached until the user detaches it.** Those sound
contradictory and are not. `take(chatId)` renders whatever *that chat* has not seen into one `tool` message ahead of
the user's words and records where it went; it returns `''` on every turn after the first, so re-sending cannot happen.
Prepended to every prompt instead, the same folder would go over the wire five times in five turns — and would sit
outside compaction, which is the only thing that can shrink it once the conversation grows. Half the prompt budget is
the attachment's; the other half has to hold the conversation it is for.

The list itself is emptied only by `remove` or `clear`, both of which are buttons. The first version emptied it at send
time, and a chip that vanished the moment a question was asked read as the app having thrown the folder away — the user
then re-attached the same project to ask a second question about it. What is remembered is therefore not "has this been
used up" but "has this chat seen it", which is also what lets one folder reach two conversations. `includedIn` is sent
as a list rather than resolved against "the current chat", because the main process does not have one.

**Attachment paths are not confined to the home directory, and `readfile.mjs` paths still are.** The difference is who
named the path: a model naming one is a request to be vetted, a person picking one through a file dialog or dropping it
on the window has already decided. A project checked out on another drive is ordinary. `SECRET_DIRS` applies to both —
"I dragged the wrong folder in" is a mistake worth catching whoever made it.

**A path is vetted by where it lands, not by what it is called.** Both guards read text, and `stat`/`readFile` follow
links — so a file called `notes.txt` sitting in home and pointing at `~/.ssh/id_rsa` satisfied every rule about the name
and then handed over the key. `readfile.mjs` resolves through `realpath` and re-vets, and `attach.mjs` does the same for
the path handed in (the walk already refuses to follow links inside a tree). Home is resolved too: on macOS it is itself
a link, and comparing an unresolved home against a resolved path refuses every read there. A link that lands somewhere
allowed still works — a project symlinked into home is ordinary, and refusing it would break a working setup to fix
nothing.

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

**A multi-part shard is never downloaded as if it were a model.** `pickGgufFile` returns null for a repo that offers
nothing but `…-00001-of-00003.gguf`, and `resolveTarget` says so in a sentence naming the alternative. One shard
downloads cleanly, is a real GGUF of a plausible size with a readable header, and is accepted into the vault — and then
fails inside llama-server minutes later, long after the progress bar the user watched said it had arrived. The refusal
is the only place they can still be told something useful.

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

**`offloaded 43/43 layers to GPU` is not the same statement as "the model is on the GPU".** llama.cpp answers two
questions and they can disagree: the summary counts *layers*, the `load_tensors:` buffer lines weigh *bytes*. Gemma
keeps its per-layer input embeddings on the processor whatever `-ngl` says — a 7.1 GB gemma-4-E4B loaded as 3876 MiB on
Vulkan0 and 3381 MiB `CPU_Mapped`, 47% of the weights in RAM and paid on every token, under a badge reading `RUN: GPU`.
That is the same class of wrong answer as reporting a GPU on a machine with none. `PlacementReader` lets the summary
describe the split but never promote it: past `CPU_WEIGHT_LIMIT` (15%) of the weight bytes in RAM the reading is
`partial` however many layers were counted. The threshold cannot be zero — a genuinely full offload still leaves the
token-embedding table behind, and the largest vocabulary in circulation is under 8% of the model it belongs to. When
the split is in bytes rather than layers the badge says so (`RUN: GPU 53% WEIGHTS + CPU`); printing `43/43 LAYERS + CPU`
states something true that no one can act on.

**KV cost is not one rate times every layer.** Three things in the header change it and all three were being ignored.
**Head width** is `key_length`, not `embedding_length / head_count`, for the models that state it — gemma-4 says 512
where the division gives 320. **`shared_kv_layers`** counts trailing layers that reuse an earlier cache and allocate
none of their own, 18 of gemma-4-E4B's 42. **`sliding_window_pattern`** is one bool per layer marking the ones that
never cache more than their window plus the batch in flight, so their cost is a constant and not a rate — which is why
`kvBudget` returns `{perToken, fixedBytes}` and callers subtract the fixed part from the budget before dividing.
Measured against llama.cpp at 32768 tokens: 512 MiB over 4 full layers and 100 MiB over 20 windowed ones, against the
2.6 GB one flat rate predicted. That surplus is subtracted from VRAM before layers are placed, so an imaginary gigabyte
of cache pushes real layers onto the processor — and it capped this model at 15872 tokens on a card that holds 32768.
The pattern array is the only array `parseGgufHeader` materialises; everything else is the tokenizer's and is skipped.

**The size-only placement estimate reserves a third of the card.** The KV cache is not a rounding error: on a 9B at 32k
it is several gigabytes, and an earlier "size + 25%" margin labelled models GPU-resident that in fact ran two thirds of
their layers on the CPU. Exact placement comes from the header via `models/placement.mjs`; the estimate is only for
search results, where the header is inside a file we have not downloaded.

**An exit code is not a diagnosis.** `llama-server exited (1)` named no cause and suggested no fix. The last 60 lines of
its output are kept and `summariseFailure` turns them into a sentence, naming the remedy for the failures that have one
(VRAM exhaustion, a port clash, an unknown flag). Classification runs on the **raw** lines: llama.cpp's severity marker
is a bare `E` field, and an earlier version stripped it for readability *before* looking for it, so every unrecognised
failure reported the cleanup message that follows the real error.

**On Windows a crash is not an exit code, and an empty log is itself evidence.** `llama-server exited (3221225477)
without saying why` is 0xC0000005: Windows kills a faulting process and the NTSTATUS lands where an exit code would go.
The reported case was a current llama.cpp build (Clang 20) against a three-year-old Visual C++ redistributable
(14.31.31103) — MSVCP140.dll *loads*, so there is no missing-DLL error to go on, and then it faults before `main` runs.
Nothing was printed, so `summariseFailure` had nothing to quote and fell through to the number, which is the very
failure this module exists to prevent. `explainCrash` names the statuses that have a remedy (an out-of-date runtime, a
missing DLL, two builds mixed in `tools/llama`, the wrong architecture, a build wanting CPU instructions this processor
does not have) and the summary is consulted **after** the log: a process that said what was wrong is always worth
quoting, and reading a benign last line — `load_backend: loaded RPC backend` — as the reason for a crash points at the
one thing that worked. Nothing below 0xC0000000 is one of these and no ordinary exit code reaches that high, so no
platform check is needed to tell them apart.

**`probeServerBinary` runs `--version` before a model load.** A binary that cannot start has nothing to do with the
model, and finding that out after a header read, a spawn and a 180-second wait — with the status bar reading
`LOADING <model>` throughout — sends the user to the wrong question entirely. Only a *crash* status is fatal to it: a
build that merely dislikes `--version` exits non-zero with something to say, and grounding a working server over that
would be worse than the bug it prevents. It is asynchronous on purpose. `spawnSync` would freeze the window for the
whole timeout on a binary that never answers — an ordinary GUI program picked in SETTINGS does exactly that — and
blocking the UI is the one thing running inference out of process is meant to prevent.

**One load at a time, and the guard is a field rather than a reading of `#state`.** `starting` is only set several
awaits into `load()` — after the header read, the binary probe and the port check — so two clicks in that window both
saw `idle`, both probed, and both went on to spawn a server. The second loses the port to the first and reports that
failure over the top of a load that was working. `load()` is a thin synchronous wrapper that stores the in-flight
promise before anything can yield; asking twice for the *same* model returns that same promise, because a double click
is not a mistake.

**Nothing in the main process may use `spawnSync` on a binary a user chose.** `#ensureBinary` probed PATH that way and
would freeze the window for as long as the process took to answer — and the wrong `llama-server` on PATH (a GUI
program, a wrapper waiting on input) never answers at all. `probeServerBinary` asks the same question with a deadline.
`llamaServerStatus` still uses `spawnSync` for `where`/`which`, which is a shell builtin's worth of work on a fixed
argument.

**`close`, not `exit`, is when a child's output is complete.** `exit` fires when the process is gone, which can be
before its pipes have drained, so concluding there can read an empty tail for a server that explained itself on the way
out — and print "without saying why" over the top of the answer. The relay also flushes the partial line still in its
buffer on `end`: a failed `GGML_ASSERT` prints and aborts on the spot, without a trailing newline, so the one line
worth keeping was exactly the one being dropped.

That lateness is also why the handler asks whether the process it is reporting on is still `#proc`, rather than
trusting `#stopping`. `unload()` waits for `exit` and clears the flag the moment it arrives, so `close` can land after
the flag is down — and a model the user deliberately unloaded would be written up as a crash, the status bar showing a
failure for something that did exactly what was asked.

**Where the weights went is printed only at llama.cpp's `trace` threshold.** Build 10405 loads a model in seventeen
lines and not one of them names a device, so the badge read `RUN: ?` on a machine running every layer on the GPU — the
reading was honest and the evidence had simply stopped arriving, the offload summary and the per-device buffer lines
having moved above the default verbosity of 3. `server.mjs` spawns with `-lv 4`. It is the only source: `/props`,
`/v1/models` and `/slots` were all checked and none of them mentions a device, and `--log-file` duplicates the console
stream rather than diverting it. Those lines also carry a timestamp and a severity field now (`0.01.369.125 I
load_tensors: …`), which is why `BUFFER_RE` in `offload.mjs` no longer anchors at the start of the line — the literal
`load_tensors:` marker is what keeps the KV cache and the compute buffers out of an answer about the weights, and it
must stay.

**Trace is 246 lines for a load and 38 more on every turn, and the activity log is not a trace viewer.** `logFilter`
splits the two audiences: the placement reader and the 60-line failure tail see every line, the log sees warnings,
errors, and anything from a build that prints no severity field at all. It filters on llama.cpp's own severity marker
rather than on a list of which components are dull, because that list is precisely what goes stale — this filter exists
because the lines it reads moved once already. An unprefixed line is a wrapped continuation and shares its heading's
fate; llama.cpp wraps both indented (the sampler parameters) and at column 0 (the chat template it echoes back, in the
model's own turn syntax), and eleven lines of Gemma's turn markers with nothing above them to explain them is worse than
none. The exception is a line reading as a complaint: a failed `GGML_ASSERT` prints bare, and taking it for a
continuation would hide the one line worth having. The lifecycle lines this hides — `loading model`, `model loaded`,
`listening on` — are already in the status bar, in the user's own words, off the `state` event.

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
