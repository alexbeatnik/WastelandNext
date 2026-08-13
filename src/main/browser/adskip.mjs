/**
 * Clicking YouTube's skip button as soon as it appears.
 *
 * There is no JS evaluation to lean on: the engine's `page.eval` exists only
 * inside a handler callback, not as a session command, so an injected watcher
 * is not an option. What the engine does offer is reading a CSS selector and
 * clicking a label — which is enough. The button is *detected* by selector, and
 * then clicked by the very text that was just read off it, so the click targets
 * something known to be on screen rather than a guess.
 *
 * Scoped to YouTube on purpose. A general "click anything that says skip" would
 * eventually click something that matters on a site nobody was thinking about.
 */

/** Hosts the watcher will act on. */
const YOUTUBE_HOST = /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/i;

export function isYouTubeUrl(url) {
  try {
    return YOUTUBE_HOST.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

/**
 * The skip button, across the player markup YouTube has used.
 *
 * Read as one selector: the engine returns the text of whichever matches, and
 * an empty answer simply means no ad is asking to be skipped.
 */
export const SKIP_SELECTORS = [
  '.ytp-ad-skip-button-modern',
  '.ytp-ad-skip-button',
  '.ytp-skip-ad-button',
  'button[id^="skip-button"]',
  '.ytp-ad-overlay-close-button',
];

export const SKIP_SELECTOR = SKIP_SELECTORS.join(', ');

/**
 * Turn the text read off the button into something to click.
 *
 * The engine targets by visible label, so the label is whatever the button
 * actually says — which keeps this working in any interface language without a
 * list of translations. Multi-line or padded text is trimmed to its first line;
 * a quote would break the DSL string and is stripped.
 */
export function skipLabel(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return '';

  const cleaned = line.replace(/['"]/g, '').trim();
  // A "button" whose text runs to a paragraph is not the skip button; reading
  // one would mean the selector matched something unexpected.
  if (!cleaned || cleaned.length > 40) return '';
  return cleaned;
}
