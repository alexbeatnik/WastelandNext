/**
 * What kind of thing a plugin is.
 *
 * The list grew past the point where one column of rows reads as anything. Four
 * capabilities, a music player, a language, a theme pack and a game are not a
 * list, they are five lists printed on top of each other — and the ones that
 * matter least are the ones a user scrolls past looking for the switch they
 * came for.
 *
 * Here rather than beside the plugin host because both processes need it and
 * they must not disagree: the main process validates what a manifest claims,
 * the renderer decides what order the headings come in and what they are
 * called. `shared/` is also the only place a renderer may import from, and
 * anything importing `electron` cannot be unit-tested at all.
 */

/**
 * Every heading, in the order they are drawn.
 *
 * Capabilities first because that is what the section is mostly for — what the
 * model may do — and `other` last because it is where anything unrecognised
 * lands. The order is the array's, not a number on each entry: a field that
 * says "3" invites two entries that both say 3.
 */
export const CATEGORIES = [
  { id: 'capability', label: 'CAPABILITIES', blurb: 'What the model is allowed to do' },
  { id: 'input', label: 'INPUT', blurb: 'Other ways of talking to it' },
  { id: 'media', label: 'MEDIA', blurb: 'Sound and playback' },
  { id: 'everyday', label: 'EVERYDAY', blurb: 'Things it keeps track of for you' },
  { id: 'games', label: 'GAMES', blurb: 'Played in the chat window' },
  { id: 'language', label: 'LANGUAGES', blurb: 'The words the app itself uses' },
  { id: 'appearance', label: 'APPEARANCE', blurb: 'Themes and the shape of the screen' },
  { id: 'other', label: 'OTHER', blurb: '' },
];

/** Where anything unrecognised goes, and the default for a manifest that is silent. */
export const DEFAULT_CATEGORY = 'other';

const BY_ID = new Map(CATEGORIES.map((entry) => [entry.id, entry]));

/**
 * Normalise whatever a manifest said.
 *
 * An unknown category is quietly folded into `other` rather than refused. That
 * is the opposite of what `setSetting` does with a `select` value, and
 * deliberately: a setting is a control the plugin has code for, so a value it
 * never offered is a row displaying a state nothing can honour. A category is
 * a heading. A plugin from a later build that files itself under something this
 * version has never heard of is still a working plugin, and refusing to install
 * it over the word above its row would be absurd.
 */
export function normaliseCategory(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return BY_ID.has(id) ? id : DEFAULT_CATEGORY;
}

export function categoryLabel(id) {
  return BY_ID.get(normaliseCategory(id))?.label ?? 'OTHER';
}

/**
 * Split a list of rows into the sections that actually have something in them.
 *
 * An empty heading is worse than no heading: it is a promise of plugins that
 * are not there, and on the narrow layout it costs a whole line to say nothing.
 * Order comes from `CATEGORIES`, never from the order rows happened to arrive
 * in — the host sorts by built-in, then by the order a plugin asked for, and
 * that ordering still holds inside each section.
 */
export function groupByCategory(rows = []) {
  const buckets = new Map();
  for (const row of rows) {
    const id = normaliseCategory(row?.category);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(row);
  }
  return CATEGORIES.filter((entry) => buckets.get(entry.id)?.length).map((entry) => ({
    ...entry,
    rows: buckets.get(entry.id),
  }));
}
