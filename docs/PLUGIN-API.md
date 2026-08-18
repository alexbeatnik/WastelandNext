# Writing a plugin for Wasteland Next

Everything the model may *do* is a plugin. So is every theme, every language, and dictation. The two capabilities that
ship with the app — file reading and shell commands — are plugins too, imported from `src/plugins/` instead of from
disk, and they use the same API as anything you write. Browser control is not among them any more: it lives in
[its own repository](https://github.com/alexbeatnik/wasteland-plugin-manul-browser) and carries the engine it drives,
which is the best worked example of a plugin that brings something the app does not have.

This document is the whole of it. It is written to be followed straight through by a person or by an agent: the
[skeleton](#a-plugin-that-works) below is a working plugin, and everything after it is reference.

**Plugin API version 9.** Put the number your plugin actually needs in the manifest — see
[API versions](#api-versions). Declaring a version the user's build does not implement means your plugin is listed
with "update Wasteland Next" instead of being loaded, which is deliberate and much better than failing halfway through
`activate` on a function that does not exist yet.

---

## Contents

- [The two kinds of plugin](#the-two-kinds-of-plugin)
- [A plugin that works](#a-plugin-that-works)
- [The manifest](#the-manifest)
- [`activate(ctx)`](#activatectx)
- [Actions](#actions)
- [The prompt fragment](#the-prompt-fragment)
- [Per-turn context](#per-turn-context)
- [Settings](#settings)
- [Storing things](#storing-things)
- [Services](#services)
- [Themes](#themes)
- [Languages](#languages)
- [Rules that are not negotiable](#rules-that-are-not-negotiable)
- [Testing](#testing)
- [Installing and publishing](#installing-and-publishing)
- [API versions](#api-versions)
- [Checklist](#checklist)

---

## The two kinds of plugin

**A theme pack or a language pack is data.** A manifest and some CSS or a JSON dictionary, read by the app's own code.
There is nothing to run, so there is nothing to consent to, and installing one is about as consequential as changing a
setting.

**Anything with a `main` is code.** It runs in the app's main process with everything Node can reach — the filesystem,
the network, child processes. The app will not import a line of it until the user presses **ALLOW AND RUN** on its row.
Installing is not switching on.

Neither kind runs code in the chat window. The renderer executes the application's own scripts and nothing else
(`script-src 'self'`, context isolation, a sandboxed preload). This is why a plugin that wants to play audio asks the
app for the `audio` service rather than shipping a player, and why a plugin that wants a microphone asks for `mic`.

---

## A plugin that works

A plugin is a directory. Everything except `plugin.json` is optional.

```
my-plugin/
├── plugin.json
├── main.mjs        # omit for a theme or language pack
├── icon.svg        # optional, 24×24
├── themes/*.css    # optional
└── locales/*.json  # optional
```

**`plugin.json`**

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "apiVersion": 5,
  "description": "One sentence, shown in the plugin list.",
  "author": "you",
  "category": "everyday",
  "icon": "icon.svg",
  "main": "main.mjs",
  "actions": ["do_thing"],
  "services": [],
  "settings": [
    { "key": "folder", "type": "folder", "label": "Where the things are" }
  ],
  "order": 50
}
```

**`main.mjs`**

```js
export function activate(ctx) {
  ctx.prompt(`
THINGS — {"type":"do_thing","steps":"<what to do>"}

You CAN do the thing in this session. "I can't do that" is wrong here — this
action is how you do it, and it costs one turn.`);

  ctx.action({
    type: 'do_thing',
    run: async (steps, turn) => {
      turn.status('Doing the thing…');
      if (!steps) {
        return {
          ok: false,
          summary: 'nothing was asked for',
          feedback: '[THINGS] Nothing was named. Ask the user what they meant.',
        };
      }
      return {
        ok: true,
        summary: `did ${steps}`,
        feedback: `[THINGS] Done: ${steps}. Say so in one short sentence.`,
      };
    },
  });
}

export function deactivate() {
  // Release anything that outlives an import: timers, watchers, child processes.
}
```

Drop the directory into the app's `plugins/` folder (see [Installing](#installing-and-publishing)), restart, and switch
it on in **PLUGINS**.

---

## The manifest

Every field is validated before a line of your code is imported. A manifest that does not parse is still a row on
screen, with the reason on it — it is never silently absent.

| Field | Required | What it is |
|---|---|---|
| `id` | yes | `[a-z0-9][a-z0-9-]{0,39}`. **Must equal the directory name.** It becomes a key in the app's config and part of a URL. |
| `name` | no | Shown in the list. Defaults to the id. |
| `version` | no | Compared numerically, so `1.10.0` is newer than `1.9.0`. Defaults to `0.0.0`. |
| `apiVersion` | yes | The API your plugin needs. A higher number than the build implements means "listed, not loaded". |
| `description` | no | One sentence. It is the only thing most people read. |
| `author` | no | Shown on registry rows. |
| `category` | no | The heading your row is drawn under — see [Categories](#categories). Anything unrecognised becomes `other`. |
| `main` | for code | Entry point, a path inside your own directory. Its presence is what makes this a plugin that needs approval. |
| `icon` | no | A path inside your directory. SVG with open strokes survives the app's colour filter best. |
| `actions` | no | Action types the model may emit. `[a-z][a-z0-9_]{0,39}`. Registering one you did not declare throws. |
| `services` | no | `audio`, `mic`, `notify`, `scene`. Asking for one you did not declare throws. |
| `settings` | no | Controls drawn on your row — see [Settings](#settings). |
| `panel` | no | Draw those settings as a section of the left panel too. A heading, or `true` for your own name — see [Settings](#settings). |
| `themes` | no | `[{id, name, file}]` — see [Themes](#themes). |
| `locales` | no | `[{id, name, file}]` — see [Languages](#languages). |
| `order` | no | Where your prompt fragment sits relative to others. Lower goes first. Default 100. |
| `enabledByDefault` | no | Only meaningful for a pack with no code. Default true. |

Two refusals worth knowing about, because they look like bugs otherwise:

- **Declaring `actions` or `services` with no `main`** is refused. A plugin listed as working while doing nothing is
  worse than one that says why it will not load.
- **A `main`, `icon`, `themes[].file` or `locales[].file` that leaves your directory** — absolute, drive-lettered, or
  containing `..` — is refused. Backslash counts as a separator.

### Categories

`category` is the heading your plugin is drawn under, in the installed list and in **GET PLUGINS** alike.

| Id | Heading | What goes there |
|---|---|---|
| `capability` | CAPABILITIES | What the model is allowed to do — anything contributing an action |
| `input` | INPUT | Other ways of talking to it. Dictation is the one that exists |
| `media` | MEDIA | Sound and playback |
| `everyday` | EVERYDAY | Things it keeps track of for you: reminders, notes, a shopping list |
| `games` | GAMES | Played in the chat window |
| `language` | LANGUAGES | The words the app itself uses |
| `appearance` | APPEARANCE | Themes and the shape of the screen |
| `other` | OTHER | Where anything unrecognised — or unstated — lands |

**A category this build has never heard of is folded into `other`, not refused.** That is the opposite of what a
`select` setting does with a value it was never offered, and deliberately so: a setting is a control your code reads
back, so a value you never declared is a row displaying a state nothing can honour, while a category is a word above
your row. A plugin from a later build filing itself under a heading this version does not have is still a working
plugin, and refusing to load it over that word would be absurd.

Which is why **saying nothing costs more than guessing wrong**. There is no penalty for a heading the build does not
know and no reward for leaving the field out — an absent category is `other`, and OTHER is the pile every heading
exists to break up.

Publish it in your registry entry as well as in the manifest (see [From a registry](#from-a-registry)). What is
available is listed before anything has been downloaded, and at that point your manifest is inside an archive nobody
has fetched.

---

## `activate(ctx)`

`main.mjs` exports `activate`, and optionally `deactivate`. Both may be async.

```js
export function activate(ctx) { /* register everything here */ }
export function deactivate() { /* stop timers, close handles */ }
```

Contributions are collected during `activate` and committed only once it has **returned**. A plugin that registers two
actions and throws between them registers neither — half a plugin is worse than none, because the model would be
holding an action whose other half never arrived.

| | |
|---|---|
| `ctx.id` | Your plugin's id. |
| `ctx.apiVersion` | The API version this build implements. |
| `ctx.action({type, run, choose})` | An action the model may emit. See [Actions](#actions). |
| `ctx.prompt(text)` | The slice of the system prompt documenting your actions. See [the prompt fragment](#the-prompt-fragment). |
| `ctx.context(fn)` | Text recomputed each turn and appended to the prompt. See [per-turn context](#per-turn-context). |
| `ctx.onTurnStart(fn)` | Called once per user message, before the first model call. |
| `ctx.service(name)` | A service named in your manifest. See [Services](#services). |
| `ctx.store.get(key, fallback)` | One of your declared settings, as the user filled it in. Read live. |
| `ctx.store.all()` | All of them. |
| `ctx.onSettingsChanged(fn)` | `fn(key, value)` after the user edits one. |
| `ctx.state.get()` / `ctx.state.set(obj)` | Your own JSON document. See [Storing things](#storing-things). |
| `ctx.dataDir()` | A directory of your own, for files. |
| `ctx.progress(text, {received, total})` | A long job, drawn on your row. `''` takes the line away. |
| `ctx.log(text)` | A line in the activity log, prefixed with your id. |

---

## Actions

```js
ctx.action({
  type: 'do_thing',       // must be in the manifest's `actions`
  run: async (steps, turn) => ({ ok, summary, feedback, choices }),
  choose: async (choiceId, { status, log }) => ({ ok, summary }),   // optional
});
```

### `run(steps, turn)`

`steps` is the raw string the model emitted — its own words, not parsed. Return an object:

| Field | Meaning |
|---|---|
| `ok` | Whether it worked. Draws the card as `✓` or `✗`. Default true. |
| `summary` | One line, shown to the user on the action card. |
| `feedback` | What the **model** reads on the next turn. This is where you tell it what to say. |
| `choices` | Optional `[{id, label, note, title}]`, drawn as buttons under the card. |

`turn` is deliberately small:

| | |
|---|---|
| `turn.signal` | An `AbortSignal`, aborted when the user presses Stop. Pass it to `fetch` and `spawn`. |
| `turn.status(text)` | The status line under the composer. |
| `turn.log(text)` | The activity column. |
| `turn.confirm({kind, command})` | Puts the app's own approval dialog in front of the user; resolves to a boolean. |

**Write `feedback` as an instruction, not as data.** A local model reads it as the account of what happened and tends
to repeat it verbatim unless told otherwise. `[MUSIC] Now playing "X". Say what is playing in one short sentence.` is
the shape that works. Naming the tag in brackets helps the model attribute the result when several actions ran.

**Throwing is safe.** A handler that throws produces feedback the model can act on, exactly as returning `{ok: false}`
does. Nothing a plugin does may end a turn — without that, a third-party typo would leave the transcript with a
blinking cursor and no reply. Prefer returning a failure with a `feedback` that names the remedy; throw when the
message alone is the useful part.

### `choose(choiceId, {status, log})`

A press on one of the buttons `run` returned. It arrives long after the turn finished, so there is no `signal` and no
turn — it is a user action, like pressing the player's next button.

**Carry a token in the id.** A second search replaces your offered list while the first is still on screen and still
clickable; a bare index would quietly pick from the newer list and act on something the user never saw offered.

```js
let offered = { token: '', items: [] };
let count = 0;

// in run(), when several things match:
count += 1;
offered = { token: `o${count}`, items: hits.slice(0, 8) };
return {
  ok: true,
  summary: `${hits.length} possible matches`,
  choices: offered.items.map((item, at) => ({ id: `${offered.token}:${at}`, label: item.title, note: item.detail })),
  feedback: '[THINGS] Several could be meant, and the user has the list with a button on each. Tell them to pick — do not choose for them, and do not repeat the list.',
};

// and in choose():
choose: async (choiceId) => {
  const [token, at] = String(choiceId).split(':');
  if (token !== offered.token) throw new Error('that list is no longer the current one');
  const picked = offered.items[Number(at)];
  if (!picked) throw new Error('that list is no longer the current one');
  return { ok: true, summary: picked.title };
},
```

Use choices when the model would otherwise be guessing and the user is the only one who knows — five near-identical
files, three recordings of the same song. Do not use them for something destructive without the user having asked for
that specific thing first.

---

## The prompt fragment

**Name the refusal your action exists to prevent, and say plainly that it is wrong in this session.** Describing the
action accurately is not enough.

This is the single most common way a working plugin appears broken. `audio-player` shipped a fragment that described
`play_music` correctly and never said "I can't play music" was false — and the first request to play a song got
*"I can't directly play music. However, I can search for it on YouTube for you."* from a model holding the action.
Local models are strongly disposed to explain what an assistant cannot do, and they will do it with the tool in hand.

```
MUSIC — {"type":"play_music","steps":"<what to play>"}

You CAN play music in this session. It plays out of the user's own speakers,
from their own folder, through the player in the chat window. "I can't play
music", "I can't directly play audio" and "I can only search for it" are all
wrong here — this action is how you do it, and it costs one turn. Never offer
to look a song up on YouTube instead of playing it.
```

Also worth doing:

- **Show a worked example** in a fenced `action` block. Models copy shapes far more reliably than they follow prose.
- **Say what to do when it fails**, not just when it works.
- **Say how to answer.** "Say what is playing in one short sentence" prevents a model reading your whole feedback
  string out loud.
- **Push back against neighbouring sections.** If browser control is installed, its fragment is long, prescriptive and
  carries a worked example of playing a song on YouTube; anything competing with that has to say so explicitly.

Your fragment is in the prompt only while your plugin is switched on. A disabled capability is *absent* from the
prompt, never forbidden in it — a model told about a tool reaches for it, and the resulting refusal reads to the user
as a bug.

**Do not add a fragment for something the model cannot operate.** Voice input contributes none: dictated text arrives
in the composer exactly as if typed, nothing the model can do changes, and describing a microphone would only invite
it to offer to "listen".

---

## Per-turn context

```js
ctx.context(async () => {
  if (!somethingWorthSaying) return '';   // an empty string contributes nothing
  return `[THINGS] ${count} pending — ${names}.`;
});
```

Recomputed before every model call, including the follow-up calls inside one turn, and appended to the system prompt.
Include your own heading. A provider that throws is logged and skipped; it does not cost the turn its prompt.

This is where facts the model needs but cannot ask for go — the current page map, the local time, what is queued. It
is also charged against the context window on every call, so keep it short and return `''` when there is nothing to
say.

---

## Settings

Declared in the manifest, drawn on your row — and in a panel section of your own if you ask for one — edited by the
user, read live through `ctx.store`.

```json
"settings": [
  { "key": "library", "type": "folder", "label": "Music folder" },
  { "key": "endpoint", "type": "text", "label": "Server", "placeholder": "http://…" },
  { "key": "loud", "type": "toggle", "label": "Start loud" },
  { "key": "model", "type": "select", "label": "Speech model",
    "options": [{ "value": "small", "label": "small — fastest (≈466 MB)" },
                { "value": "large", "label": "large — best (≈547 MB)" }] }
]
```

| Type | Control | Value |
|---|---|---|
| `text` | A text box, saved on idle | string |
| `folder` | `[ CHOOSE… ]`, a native directory dialog | absolute path string |
| `toggle` | A checkbox | boolean |
| `select` | A dropdown | one of the `options` values |

A `select` names its options in the manifest so the control can be drawn before any of your code has run — and the app
**refuses to store a value you never offered**, so you can read one back without checking it.

`ctx.store.get(key)` reads live rather than at activation, so a value the user changed a moment ago is the one you see.
`ctx.onSettingsChanged(key, value)` exists for the settings that invalidate work already done — a music folder is the
case in point, since nothing else would make the library rescan.

### A section of your own

Your row in PLUGINS is where somebody *decides* about your plugin: it is beside the description, the version and the
switch that turns the whole thing off. It is a poor place to *use* a setting — reported of a music folder and a browser
choice, both changed almost daily, that reaching either meant opening PLUGINS and reading a dozen rows to remember
which control was which.

`panel` puts the same settings in the left panel, under a heading of your own:

```json
"panel": "MUSIC"
```

`true` uses your plugin's name instead. Nothing else changes: the same declarations, the same controls, the same
storage — the app simply draws them in a second place. There is no second way to define a control, and nothing your
code has to do.

Two rules follow from what a section is:

- **It is only drawn while your plugin is running.** Switched off, the section goes with it — the same rule the audio
  transport and the game panel follow, because a control that is drawn and cannot work is worse than one that is absent.
- **A `panel` with no `settings` is refused at load time**, with a reason. A section that opens onto nothing is a
  promise of controls that are not there.

The heading is trimmed to 24 characters and flattened to one line: the panel is a narrow column, and a heading that
wraps to three lines pushes everything below the fold.

---

## Storing things

Three places, and they are not interchangeable.

**`ctx.store`** — the user's answers to the questions your manifest asked. Every key is a control on your row.

**`ctx.state`** — your own JSON document, for what nobody declares: a list of reminders, a cache, a counter.

```js
const held = ctx.state.get();                    // {} the first time
ctx.state.set({ items: [...(held.items ?? []), one] });
```

It is written whole and renamed into place, because a half-written file reads back as `{}` — which would be everything
the user had, gone, with nothing saying so. One megabyte is the ceiling. Writes are synchronous; the call has happened
by the time it returns.

**`ctx.dataDir()`** — a directory of your own, for files: a downloaded model, an extracted binary, a cache too big to
be a document.

Both live **outside** your installed directory, which is deleted and replaced on every update. A model downloaded into
your own directory would be downloaded again on every version bump. Both are removed when the user uninstalls you.

---

## Services

Named in the manifest, handed over by name. Asking for one you did not declare throws — that is what makes the plugin
list a true account of what a plugin can reach rather than a summary somebody wrote.

There are four, and the list is short on purpose. A service exists for what has to be **shared**: one audio bar, one
microphone button, one game panel, one notification queue, each of which needs an owner to arbitrate between two
plugins wanting it. Everything else you can simply do — your plugin runs in the main process with everything Node can
reach, and may spawn a process, open a socket or ship a binary in its own archive. If you are looking for a service
that would only ever have one caller, you are looking for code you can write yourself.

### `notify`

For the one message with no question in front of it.

```js
const notify = ctx.service('notify');
notify.show({ pluginId: ctx.id, title: 'Watch the series', body: 'Due at 18:45' });
notify.show({ pluginId: ctx.id, title: 'You missed 2 reminders', body: lines, desktop: false });
```

Goes two places at once — a card in the transcript and an operating system notification — because neither is enough
alone: the first is invisible to somebody in another window, the second is gone the moment it is dismissed. Pass
`desktop: false` for something raised while the window is opening anyway; a system toast for what the user is already
looking at is noise.

Notices raised before the window is listening are kept and shown on the way in, which is what makes "the app was closed
when this came due" work. Your *name* is not passed — it is resolved from `pluginId` where the notice is drawn, so a
plugin cannot sign a message with a name other than the one on its own row. Six notices a minute is the ceiling; past
that they are dropped and the log says so.

### `mic`

Dictation. The app owns the microphone button beside Send, the recording and the encoding to 16 kHz mono; you get a
finished WAV and return the words.

```js
const mic = ctx.service('mic');
mic.setTranscriber({
  pluginId: ctx.id,
  label: 'Whisper small',
  ready: false,                       // true once a model is actually on disk
  transcribe: async (wavPath) => 'what they said',
});
mic.setReady(ctx.id, true, 'Whisper small');
```

`ready` is what decides whether the button is drawn at all, and it means "there is a model on disk", not "this plugin
is switched on". A microphone that records into nothing is a dead control, and your row is where a model is obtained.

The WAV is deleted as soon as `transcribe` returns, whether it returned a transcript or threw. Anything you write
beside it is yours to remove.

### `audio`

Sound output. The app owns the `<audio>` element and the transport bar; you own everything that makes it a player.

```js
const audio = ctx.service('audio');
audio.load({ path, label: track.title, sublabel: `${track.artist} · 3 of 47` }, { play: true });
audio.play(); audio.pause(); audio.clear();
audio.setTransport({
  pluginId: ctx.id,
  buttons: ['previous', 'next', 'stop'],   // only these three exist; an undeclared one is never drawn
  handle: (command) => { /* 'next' | 'previous' | 'stop' | 'ended' */ },
});
```

There is no queue in the service on purpose: what "next" means is your business, and two plugins with different ideas
can drive the same bar. The bar's second line is your words — "3 of 47", "shuffled" — because only you know them.

### `scene`

A panel the app draws from a document you fill in, and a row of buttons above the composer. For a game, a tracker,
anything with state a user needs to see at a glance and act on without typing a sentence.

```js
const scene = ctx.service('scene');

scene.present({
  pluginId: ctx.id,
  pluginName: 'Fantasy RPG',
  act: async (actionId) => {
    if (actionId === 'bag') {
      scene.show(sheetFor(state));            // redraws the panel, costs nothing
      return { status: 'Inventory.' };
    }
    return { submit: 'I look around' };       // sent as if the player typed it
  },
});

scene.show({
  title: 'Village of Mara — day 4',
  subtitle: 'the common room',
  meters: [{ label: 'HP', value: 12, max: 20, tone: 'bad' }, { label: 'GOLD', value: 14 }],
  fields: [{ label: 'QUEST', value: 'find the hunters' }],
  tags:   [{ label: 'BLEEDING', tone: 'bad' }],
  groups: [{ label: 'ITEMS', items: [{ label: 'Notched sword', note: 'a weapon' }], empty: 'nothing on you' }],
  actions: [{ id: 'look', label: 'Look around', hint: 'costs a turn' }, { id: 'bag', label: 'Inventory' }],
});

scene.clear();                                 // the game is over; the panel goes
```

Every field is optional and every one has a shape. What does not fit is dropped rather than thrown over: a game that
stops working because one label was a number is worse than a game with one label missing. Labels are collapsed to one
line, because they are drawn in a flex row. `tone` is `good`, `warn` or `bad` — anything else becomes plain, and it is
the only field that reaches a class name.

A meter with no `max` is drawn as a bare number, not as a bar filled to an imaginary limit. `groups` appear behind the
**[ SHEET ]** button and in no other place, so a long inventory never competes with the transcript; `empty` is your
words for an empty one, since only you know whether the sentence is "nothing on you" or "the journal is blank".

**A list row can be a control.** Give an item an `action` and it is drawn as a button that calls `act` with that id:

```js
groups: [{
  label: 'ITEMS',
  items: [
    { label: 'Notched sword', note: 'in hand — press to put away', tone: 'good', action: 'item-sword' },
    { label: 'Herb',          note: 'press to use',                 action: 'item-herb' },
  ],
}]
```

Optional on purpose — a journal is not an inventory, and an entry that could be clicked and did nothing is worse than
one that plainly cannot be. Those ids are on offer exactly as the moves are, so a row from a bag emptied three turns ago
is refused with the same sentence.

**A board is a picture with pressable places on it.** For a map, a chart, anything positional:

```js
board: {
  image: 'map.png',                     // a file in ctx.dataDir(), or omit it
  points: [
    { id: 'village', label: 'Village', x: 50, y: 84, here: true },
    { id: 'forest',  label: 'Forest',  x: 58, y: 56, tone: 'good', action: 'go-forest' },
    { id: 'tower',   label: 'Tower',   x: 55, y: 11 },              // seen, not reachable
  ],
  links: [{ from: 'village', to: 'forest', tone: 'good' }],
}
```

`x` and `y` are percentages, so the same numbers work at any size. `here` marks where the piece stands — its own fact
rather than a fourth tone, because "you are here" is not a shade of good or bad. A point with an `action` is a button;
one without is a label. A link naming a point that is not on the board is dropped rather than drawn off the edge.

**The picture is scenery and nothing else.** The markers, the roads and the labels are drawn by the app over the top,
from this data. Do not paint them into the image: a game whose map differs from run to run — a shuffled layout, a road
that opens later — would be showing something false, and a marker would land where the artist put it rather than where
you said. Generate a background, and let this be the map.

`image` names a file in **`ctx.dataDir()`**, not in your installed tree: that tree is deleted and rewritten on every
update, so a map the user generated themselves would disappear on a version bump. Omit it entirely and the board still
works — the markers and roads are the map, the picture only makes it pleasant.

**`act` may answer `{board: true}`** to open it, exactly as `{sheet: true}` opens the lists.

**`act` may answer `{sheet: true}`** to open the sheet. It is the only way you can: the dialog belongs to the app, so an
inventory button that merely wrote a line in the status bar would be a control describing the thing it should have
shown. Honoured before `submit`, so a move that opens the bag *and* takes a turn shows the bag first.

**The app assigns the hotkeys.** The first nine actions get `1`–`9` by position; you do not ask for a key, and two
actions cannot collide over one. `0` opens the sheet. Every digit is ignored while the composer has focus — a typed
sentence must not make a move.

**`act` returns, it does not send.** `{status}` writes a line in the status bar; `{submit}` is sent as an ordinary
message in whatever conversation is open, exactly as if the player had typed it — same busy check, same transcript
entry, same handling when a send fails. Both are optional, and a move that only redraws the panel involves no model at
all, which is the point: opening an inventory should not cost a turn or a single token.

Nothing here can start a turn on its own. A move goes out because somebody pressed a key, and `act` is the only way in.

**The panel lives in the conversation the game is played in.** A scene shown during a turn is claimed by that turn's
chat and drawn only there; open another conversation and it is gone, along with its hotkeys. You are never told which
chat that is and never need to be — the app stamps it.

The corollary is that **a scene shown outside a turn claims no conversation and is drawn nowhere.** Painting at
activation therefore shows nothing: at that moment nothing in the app knows where the game is being played, and
guessing would put your panel over somebody's unrelated chat. Draw when a turn runs. Your state is not at risk either
way — it is in `ctx.state`, and your `ctx.context()` fragment reaches the model whether or not a panel is on screen.

One plugin drives the panel at a time and the newcomer wins, as with the audio transport. When yours is switched off
the panel goes with it — and an action id that is no longer on screen is refused, so a stale click cannot make a move
in a world that has moved on.

### There is no browser service

There used to be two — the visible Chrome and a headless one — and they are gone. Browser control is
[a plugin](https://github.com/alexbeatnik/wasteland-plugin-manul-browser) that owns its engine, spawns its own
sessions and closes them in `deactivate`. Declaring `browser` or `lookupBrowser` in a manifest is now a load-time
error naming the unknown service.

That is worth reading as a pattern rather than as a loss. A plugin runs in the main process with everything Node can
reach: it may spawn a process, open a socket, ship a binary in its own archive. A service exists only for the things
that must be *shared* — one audio bar, one microphone button, one game panel, one notification queue — because two
plugins driving those need an owner to arbitrate. Nothing arbitrates a browser you launched yourself, so nothing needs
to.

---

## Themes

No code, no approval. A theme redefines the variables on `:root` and nothing else.

```json
"themes": [{ "id": "dusk", "name": "Dusk", "file": "themes/dusk.css" }]
```

```css
:root {
  /* The phosphor. Everything else is derived from these four by eye. */
  --amber: #33ff33;
  --amber-bright: #99ff99;
  --amber-dim: #1f9f1f;
  --amber-faint: #0d3d0d;

  /* Surfaces. */
  --bg: #050505;
  --bg-panel: #0a0a0a;
  --bg-deep: #000000;
  --btn-bg: #123012;
  --btn-bg-hover: #1a401a;
  --btn-bg-active: #000000;

  /* Meaning, not decoration: a failure, a success, an addition. */
  --warn: #ff6020;
  --ok: #66cc66;
  --add: #aacc00;
}
```

It is loaded after the app's stylesheet, so equal specificity wins on order and `!important` is never needed. **Set
variables, not selectors** — overriding `button { background: … }` works until the app adds a rule, which is exactly
why the button surfaces became variables. The file is served over `wasteland-plugin://`, which is the only way a
stylesheet can reach that page at all: `style-src 'self'` on a `file://` page rejects both an inline `<style>` built
from IPC text and a stylesheet in another directory.

`plugins/phosphor-themes/themes/green.css` in the registry repository is the full set worth setting; `paper.css` beside
it is the one that also touches `.crt`, and says why in a comment.

---

## Languages

No code, no approval. A dictionary keyed by the English text it replaces.

```json
"locales": [{ "id": "uk", "name": "Українська", "file": "locales/uk.json" }]
```

```json
{
  "LOCAL VAULT": "ЛОКАЛЬНЕ СХОВИЩЕ",
  "[ NEW ]": "[ НОВА ]",
  "Send": "Надіслати"
}
```

Keyed by the text rather than by invented identifiers, so adding a language is translating a list of phrases and a
partial translation works rather than breaks — a missing entry falls back to the English already on screen. Copy
`plugins/ukrainian/locales/uk.json` from the registry repository as a starting list.

---

## Rules that are not negotiable

**No code runs in the chat window.** There is no way to ship renderer JavaScript and there will not be. If you need
something on screen, it is either a service the app provides or it does not exist yet.

**An action type can be claimed once.** Built-ins are activated first. The second claimant is refused with the reason
on its row — quietly letting a newcomer shadow `system_shell` is how an action stops meaning what the prompt says it
means.

**Register your action *and* its documentation together.** It is impossible to register an action without its prompt
fragment or document one that will not dispatch, and the app's test suite asserts the two sets are equal. Do not try
to work around it.

**Clear your timers in `deactivate`.** The host drops every contribution when a plugin is switched off, but nothing
else knows about an interval. A switched-off plugin still raising notifications is the plainest possible way for its
checkbox to be a lie. Hold the handle at module scope — `deactivate` is a module export, not something `activate`
returned — and clear any previous one at the top of `activate`, because switching off and on again activates twice.

```js
let ticker = null;
export function activate(ctx) {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(tick, 20_000);
  ticker.unref?.();          // nothing of yours should keep the process alive
}
export function deactivate() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
```

**Prefer one ticker to a timer per event.** A `setTimeout` for six hours' time is a promise about a process that will
probably be restarted first, and it does not survive the machine sleeping. A ticker comparing wall-clock time against
a stored moment pays the debt the moment something is watching again.

**Updating a plugin needs a restart to take effect.** Node caches modules by URL for the life of the process, so
replacing files does not replace what is running. The app says so on the row rather than pretending otherwise. Do not
try to defeat this with a query string on your entry point: the query is not inherited by your own
`import './library.mjs'`, so you get a new entry point linked against cached dependencies, which fails with
`does not provide an export named …`. This has already happened once.

**Do not import from the app.** `src/` lives inside `app.asar` in a packaged build. Node built-ins and your own files
only.

**Throttle progress.** `ctx.progress` on every chunk of a download is hundreds of IPC messages a second for a figure
nobody can read as it flickers. Four times a second is plenty.

---

## Testing

Plugins in the registry repository are tested two ways, and both are worth copying.

**Pure logic, in the registry repo.** Put the parts that do not need the app — parsing, scheduling, tag reading — in
their own module and test them with `node --test`. `tests/schedule.test.mjs` is a worked example.

**Against the real host, in the app repo.** `test/plugins.test.mjs` loads plugins from a checkout of the registry
repository sitting beside the app, with stub services, and asserts they activate, register what they claimed, and
produce the prompt they should:

```js
const host = new PluginHost({ userDir: pluginsCheckout, services: { mic: stubMic() } });
await host.load();
const row = host.list().find((plugin) => plugin.id === 'my-plugin');
assert.equal(row.active, true, row.error);
```

Clone `wasteland-plugins` beside `WastelandNext` and those tests run; without it they skip.

`row.error` carries the reason a plugin failed to activate, which is why it is passed as the assertion message — a
bare `false` tells you nothing.

---

## Installing and publishing

### While you are writing it

Put the directory in the app's plugin folder and restart:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Wasteland Next\plugins\<id>\` |
| macOS | `~/Library/Application Support/Wasteland Next/plugins/<id>/` |
| Linux | `~/.config/Wasteland Next/plugins/<id>/` |

Beside `plugins/` in the same directory you will find `config.json` (where `plugins.<id>` records whether yours is
enabled and approved), `plugin-state/<id>.json` (your `ctx.state`) and `plugin-data/<id>/` (your `ctx.dataDir()`).
Deleting the whole `plugins/<id>` directory and the two entries is a clean uninstall by hand.

The directory name must equal the manifest's `id`. Switch it on in **PLUGINS**; a plugin with code needs
**ALLOW AND RUN** once.

### From an archive

**GET PLUGINS → `[ FROM FILE… ]`** installs a `.zip` you pick yourself: a plugin that was never published, a build
handed over on a stick, or a machine that cannot reach a registry. Zip from *inside* the plugin directory so
`plugin.json` is at the archive root (one wrapper directory is tolerated).

There is no checksum, because there is no index making a claim about the bytes — what is trusted is that you chose the
file. Every other check still runs, and the code does not run until it is approved.

### From a registry

A registry is a URL serving an `index.json`:

```json
{
  "schema": 1,
  "updated": "2026-08-15",
  "plugins": [
    {
      "id": "my-plugin", "name": "My plugin", "version": "1.0.0",
      "description": "…", "author": "you", "apiVersion": 5,
      "kind": "code", "category": "everyday",
      "icon": "data:image/svg+xml;base64,…",
      "url": "https://…/my-plugin-1.0.0.zip",
      "sha256": "…", "size": 14735
    }
  ]
}
```

- **`sha256` is mandatory.** An entry without one is refused: the index is the only thing being trusted, and without a
  digest nothing ties it to the bytes.
- **`url` must be `https:`.** So must the index itself, except on loopback.
- **`icon` is a data URI or nothing.** The page allows `img-src data:` and no remote host, so a linked icon would both
  fail to draw and turn opening the plugin list into a request telling somebody who opened it.
- **`category` is read from the index, not from your manifest.** A heading is there to help somebody decide whether to
  download the archive, and the manifest is inside the archive. An entry without one is listed under OTHER however the
  manifest files itself once it is installed.

Users add a registry in **GET PLUGINS → REGISTRIES**; pasting `https://github.com/owner/repo` expands to the raw
`index.json` on `main`. Several registries are asked in parallel, and where two publish the same id the newest version
wins with the source shown on the row.

In the `wasteland-plugins` repository, `scripts/build-index.mjs` packs every plugin and writes `index.json` with the
digests; the release workflow runs it. An archive uploaded by hand with no regenerated index entry is invisible.

---

## API versions

Declare the **lowest** version that has everything you use. Declaring a higher one means users on an older build see
"update Wasteland Next" instead of your plugin.

| Version | Added |
|---|---|
| 1 | Actions, prompt fragments, per-turn context, turn hooks, the `browser` and `lookupBrowser` services |
| 2 | Themes, settings (`text`, `folder`, `toggle`), the `audio` service |
| 3 | Interactive `choices` and `choose`, language packs |
| 4 | The `notify` service, and `ctx.state` — the plugin's own JSON document |
| 5 | The `mic` service, `select` settings, `ctx.progress`, `ctx.dataDir()` |
| 6 | The `scene` service — a drawn panel, a pinned row of moves and their hotkeys |
| 7 | Pressable list rows (`item.action`) and `act` answering `{sheet: true}` |
| 8 | `board` — a picture with pressable places, and files served from `ctx.dataDir()` |
| 9 | `panel` — your settings as a section of the left panel. The `browser` and `lookupBrowser` services are **removed** |

**Not every addition moves the number.** `category` arrived after 5 and did not: a build that has never heard of the
field ignores it and loads the plugin exactly as before, so declaring 6 for it would lock your plugin out of every
build that implements 5 in exchange for a heading. Raise the version you declare only for something your code would
*fail* without.

---

## Checklist

Before publishing, or before telling someone it is finished:

- [ ] `id` equals the directory name, and is lowercase letters, digits and dashes.
- [ ] `apiVersion` is the lowest that has everything you use.
- [ ] `category` names a heading the app knows, in the manifest **and** in your registry entry. An absent one is OTHER.
- [ ] Every action you register is in `actions`; every service you fetch is in `services`.
- [ ] If your settings are used often, `panel` gives them a section of their own — and a `panel` needs `settings`.
- [ ] Your prompt fragment **names the refusal it exists to prevent** and says it is wrong in this session.
- [ ] Your fragment shows a worked example in a fenced `action` block.
- [ ] Every `feedback` tells the model what to *say*, not just what happened.
- [ ] A failure returns `{ok: false}` with a reason the model can act on, and never leaves the turn hanging.
- [ ] Offered choices carry a token, and a stale click is refused in words.
- [ ] Timers are held at module scope, cleared in `deactivate`, and re-cleared at the top of `activate`.
- [ ] Long jobs report through `ctx.progress`, throttled to about four times a second.
- [ ] Anything downloaded goes in `ctx.dataDir()`, not in your own directory.
- [ ] Nothing is imported from the app's `src/`.
- [ ] `version` is bumped, and it compares numerically the way you think it does.
- [ ] The pure parts have tests, and the plugin activates against the real host.
