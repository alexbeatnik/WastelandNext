/**
 * What an update is doing, in words.
 *
 * Both halves live here for the same reason the rest of `shared/` does: the
 * main process decides what a thrown updater error *means*, the renderer decides
 * how to say it, and neither should be able to drift from the other about which
 * states exist. It is also the only part of the updater testable without an
 * installer to point it at — `updater.mjs` imports `electron`, this does not.
 */

/**
 * Turn a thrown updater error into a status.
 *
 * A repository with no releases yet is not a failure: there is nothing newer to
 * install, and reporting it as a connection problem is a lie the user acts on —
 * they go looking for a firewall that was never in the way.
 */
export function classifyError(err) {
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (/no published versions/i.test(message)) return { state: 'current' };
  // The same thing from the other direction: a release exists, but was
  // published without the file the updater reads. Worth naming exactly,
  // because the fix is in the release rather than on this machine.
  if (/latest\.yml/i.test(message) && /404|not found/i.test(message)) {
    return { state: 'error', message: 'the release is missing latest.yml' };
  }
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return { state: 'error', message: 'could not reach GitHub' };
  }
  if (/rate limit/i.test(message)) return { state: 'error', message: 'GitHub rate limit — try again later' };

  // First line only: electron-updater attaches a stack to some of these, and a
  // status line is one line.
  const first = message.split('\n')[0].trim();
  return { state: 'error', message: first.slice(0, 200) || 'update check failed' };
}

/**
 * The sentence shown in the About box.
 *
 * Every state gets one, including the ones that are nobody's fault. A blank
 * line, or a spinner that never resolves, reads as broken — "could not reach
 * GitHub" is information, silence is not.
 */
export function describeUpdate(status) {
  const state = status?.state ?? 'idle';
  const version = status?.version ? `version ${status.version}` : 'a new version';

  switch (state) {
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return 'This is the latest version.';
    case 'available':
      return `${version} is available — downloading…`;
    case 'downloading':
      return `Downloading ${version} — ${status.percent ?? 0}%`;
    case 'ready':
      return `${version} is ready. It installs when you restart.`;
    case 'error':
      return `Could not check — ${status.message || 'unknown error'}.`;
    // The portable build and a development run have no installed copy to
    // replace. Saying so beats a CHECK button that always fails.
    case 'unsupported':
      return 'Updates apply to the installed build. This one is updated by hand.';
    default:
      return 'Not checked yet.';
  }
}

/** Is there a downloaded build waiting to be installed? */
export function isReady(status) {
  return status?.state === 'ready';
}

/** Should the button be hidden — is something already in flight? */
export function isBusy(status) {
  return status?.state === 'checking' || status?.state === 'downloading';
}
