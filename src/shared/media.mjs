/**
 * Serving a file to the renderer: what it is, and which part of it was asked for.
 *
 * Carried over from A-Player, where both of these were already worked out
 * against real audio files. They live in `shared/` rather than beside the
 * protocol handler for the usual reason — one definition, and the arithmetic is
 * testable without an Electron around it.
 */

const MIME_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  weba: 'audio/webm',

  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
  woff: 'font/woff',
};

/** The audio file types the player will offer to open. */
export const AUDIO_EXTENSIONS = ['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'aac', 'wav', 'webm', 'weba'];

export function mimeFor(filePath) {
  const path = String(filePath ?? '');
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

export function isAudioFile(filePath) {
  const path = String(filePath ?? '');
  return AUDIO_EXTENSIONS.includes(path.slice(path.lastIndexOf('.') + 1).toLowerCase());
}

/**
 * What a `Range` header asks for:
 *
 * - `none`          — no header, or one this server cannot act on. RFC 9110 says
 *                     to ignore an unusable Range and send the whole file (200).
 * - `satisfiable`   — a usable range; answer with 206 and the slice.
 * - `unsatisfiable` — well-formed but entirely outside the file. This is the one
 *                     case that must not be answered with the whole file: a
 *                     client that asked for bytes past the end and got 200 sees
 *                     the start of the track where it expected the end.
 */
const NONE = { kind: 'none' };
const UNSATISFIABLE = { kind: 'unsatisfiable' };

/** Parses a `Range: bytes=start-end` header. Only a single range is supported. */
export function parseRange(header, size) {
  if (!header) return NONE;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return NONE;

  const [, rawStart, rawEnd] = match;

  // "bytes=-500" means the last 500 bytes, not a range starting at zero.
  if (rawStart === '') {
    // "bytes=-" is not a range spec at all.
    if (rawEnd === '') return NONE;
    const length = Number(rawEnd);
    // A zero-length suffix asks for nothing, and an empty file has nothing to
    // give: neither can be answered with content.
    if (length === 0 || size === 0) return UNSATISFIABLE;
    return { kind: 'satisfiable', range: { start: Math.max(0, size - length), end: size - 1 } };
  }

  const start = Number(rawStart);

  // An inverted range is an invalid spec rather than an unsatisfiable one, and
  // an invalid Range header is ignored instead of rejected.
  if (rawEnd !== '' && Number(rawEnd) < start) return NONE;
  if (start >= size) return UNSATISFIABLE;

  return {
    kind: 'satisfiable',
    range: { start, end: rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1) },
  };
}

/** `3:07`, or `1:02:33` when it earns the hour. */
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
