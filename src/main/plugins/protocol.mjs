/**
 * Two custom schemes, because `file://` and the page's CSP leave no other way in.
 *
 *   wasteland-plugin://<plugin-id>/<path>   a file belonging to a plugin — CSS, a font, an image
 *   wasteland-media://track/<encoded path>  one audio file the player currently holds
 *
 * A theme cannot be delivered any other way. The page's CSP is `style-src
 * 'self'`, which rejects both an inline `<style>` built from IPC text and a
 * stylesheet loaded from another directory — 'self' on a `file://` page is not
 * "anywhere on this disk". A scheme the CSP names explicitly is the narrow door.
 *
 * Media is a separate scheme rather than a path under the first because the two
 * answer completely different questions about what may be read: the first is
 * confined to a plugin's own directory, the second serves files from anywhere
 * on disk and is therefore restricted to the handful the player was told to
 * queue. Folding them together would mean one guard doing two jobs.
 *
 * Note for anyone adding a visualiser later: `<audio>` alone is happy with a
 * cross-origin source, but Web Audio is not — `MediaElementAudioSource` outputs
 * silence when the media is not same-origin with the page, and Chromium does
 * not implement CORS for custom schemes at all. A spectrum analyser here means
 * moving the *page* onto a custom scheme too, as A-Player had to.
 */
import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { mimeFor, parseRange } from '../../shared/media.mjs';
// The scheme names and the URL builders live in `shared/` because this file
// imports `electron` and therefore cannot be unit-tested at all — the same
// reasoning that put `classifyError` next to the updater rather than in it.
import { DATA_SEGMENT, MEDIA_SCHEME, PLUGIN_SCHEME } from '../../shared/schemes.mjs';

/**
 * Must run before `app.whenReady()`; after it, the schemes are already fixed.
 *
 * `stream: true` is what enables Range support, and without Range a seek in a
 * long track does nothing — the element can only play what it has already
 * buffered from the start.
 */
export function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function streamOf(path, range) {
  return Readable.toWeb(range ? createReadStream(path, range) : createReadStream(path));
}

/** Serve a file from disk, honouring the Range request. */
async function serveFile(filePath, rangeHeader) {
  let size;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return new Response('Not a file', { status: 404 });
    size = info.size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const contentType = mimeFor(filePath);
  const result = parseRange(rangeHeader, size);

  if (result.kind === 'unsatisfiable') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      // Tells the client how long the file actually is, so it can ask again.
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    });
  }

  if (result.kind === 'none') {
    return new Response(streamOf(filePath), {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  }

  const { range } = result;
  return new Response(streamOf(filePath, range), {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

/**
 * Install both handlers.
 *
 * @param pluginDir  id → the plugin's directory on disk, or null
 * @param pluginData id → the plugin's data directory, which updates do not touch
 * @param mediaAllows path → may the renderer read this file right now?
 */
export function serveProtocols({ pluginDir, pluginData, mediaAllows }) {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    const url = new URL(request.url);

    let decoded;
    try {
      decoded = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!decoded) return new Response('Not found', { status: 404 });

    /**
     * Two roots, one scheme, chosen by a reserved first segment.
     *
     * The installed tree is deleted and rewritten on every update, so anything
     * a *user* put there is gone on a version bump — a generated map, a
     * portrait. `ctx.dataDir()` survives that, and this is the door to it. Both
     * roots are still one plugin's own, so the confinement check below is
     * unchanged and does the same job for either.
     */
    const wantsData = decoded === DATA_SEGMENT || decoded.startsWith(`${DATA_SEGMENT}/`);
    if (wantsData) decoded = decoded.slice(DATA_SEGMENT.length + 1);
    // With `standard: true` the host is the plugin id, already lowercased by
    // the URL parser — which is why plugin ids are lowercase to begin with.
    const dir = wantsData ? pluginData?.(url.hostname) : pluginDir(url.hostname);
    if (!dir) return new Response('Unknown plugin', { status: 404 });
    if (!decoded) return new Response('Not found', { status: 404 });

    // The manifest was validated, but this path comes off a URL rather than out
    // of the manifest, so it is checked again where it is about to be read.
    const root = resolve(dir);
    const target = normalize(join(root, decoded));
    if (target !== root && !target.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });

    return serveFile(target, request.headers.get('range'));
  });

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    let filePath;
    try {
      filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Anywhere on disk is reachable through this scheme, so the answer is not
    // "is the path well formed" but "did we put this file in front of the user".
    // The queue is the allowlist; nothing else is served.
    if (!filePath || !mediaAllows(filePath)) return new Response('Forbidden', { status: 403 });

    return serveFile(filePath, request.headers.get('range'));
  });
}
