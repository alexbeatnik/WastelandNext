/**
 * The two custom schemes, and how a URL on them is spelled.
 *
 * Here rather than beside the protocol handler for the reason `updates.mjs`
 * gives: `protocol.mjs` imports `electron` and therefore cannot be unit-tested
 * at all, while everything below is pure string work that both processes need —
 * the host builds a theme URL, the audio service builds a media URL, and the
 * handler takes them apart again. One definition, so the encoding used to build
 * a URL and the decoding used to read it cannot drift.
 */

export const PLUGIN_SCHEME = 'wasteland-plugin';
export const MEDIA_SCHEME = 'wasteland-media';

/** The single host under which media is served; the path carries the file. */
export const MEDIA_HOST = 'track';

/**
 * A file belonging to a plugin: `wasteland-plugin://<id>/<path>`.
 *
 * Each segment is encoded separately so the separators survive — a theme at
 * `themes/rust.css` must stay two segments, and `encodeURIComponent` on the
 * whole string would turn the slash into `%2F` and the path into one nonsense
 * filename.
 */
export function pluginAssetUrl(pluginId, file) {
  const path = String(file ?? '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${PLUGIN_SCHEME}://${pluginId}/${path}`;
}

/** One audio file: `wasteland-media://track/<encoded absolute path>`. */
export function mediaUrl(filePath) {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(filePath)}`;
}
