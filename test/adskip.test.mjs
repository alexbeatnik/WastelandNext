/**
 * The YouTube ad watcher.
 *
 * The clicking is done by the engine, so what is testable here is which pages
 * the watcher is allowed to act on — a mistake there means clicking things on
 * somebody else's site — and how the label it clicks is derived from the text
 * it read.
 *
 * The end-to-end behaviour is covered by `scripts/adskip-live.mjs`, which
 * drives a real browser against a local page.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKIP_SELECTOR, SKIP_SELECTORS, isYouTubeUrl, skipLabel } from '../src/main/browser/adskip.mjs';

test('recognises YouTube, including its variants', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=abc',
    'https://youtube.com/',
    'https://m.youtube.com/watch?v=abc',
    'https://music.youtube.com/watch?v=abc',
    'https://www.youtube-nocookie.com/embed/abc',
    'http://www.youtube.com/results?search_query=test',
  ]) {
    assert.equal(isYouTubeUrl(url), true, url);
  }
});

test('does not act on sites that merely mention YouTube', () => {
  for (const url of [
    'https://youtube.com.evil.test/watch',
    'https://notyoutube.com/',
    'https://example.com/?ref=youtube.com',
    'https://myyoutube.com/',
    'https://example.com/youtube.com',
  ]) {
    assert.equal(isYouTubeUrl(url), false, url);
  }
});

test('malformed input is not YouTube', () => {
  for (const url of ['', null, undefined, 'not a url', 'javascript:alert(1)']) {
    assert.equal(isYouTubeUrl(url), false, String(url));
  }
});

test('the selector covers the player markups YouTube has used', () => {
  assert.ok(SKIP_SELECTORS.includes('.ytp-ad-skip-button'));
  assert.ok(SKIP_SELECTORS.includes('.ytp-ad-skip-button-modern'));
  assert.equal(SKIP_SELECTOR, SKIP_SELECTORS.join(', '));
});

/* ============================ the label to click ============================ */

test('uses whatever the button says, in any language', () => {
  assert.equal(skipLabel('Skip'), 'Skip');
  assert.equal(skipLabel('Skip Ad'), 'Skip Ad');
  assert.equal(skipLabel('Пропустити рекламу'), 'Пропустити рекламу');
  assert.equal(skipLabel('Anzeige überspringen'), 'Anzeige überspringen');
});

test('trims padding and takes the first line', () => {
  assert.equal(skipLabel('  Skip Ad  '), 'Skip Ad');
  assert.equal(skipLabel('\n\n Skip Ad \n 5 '), 'Skip Ad');
});

test('strips quotes, which would break the DSL string it goes into', () => {
  assert.equal(skipLabel(`Skip "the" ad`), 'Skip the ad');
  assert.equal(skipLabel("Skip 'now'"), 'Skip now');
});

test('nothing to click when nothing was read', () => {
  assert.equal(skipLabel(''), '');
  assert.equal(skipLabel('   \n  '), '');
  assert.equal(skipLabel(null), '');
  assert.equal(skipLabel(undefined), '');
});

test('a paragraph is not a skip button', () => {
  // If the selector ever matches something unexpected, clicking a label made of
  // prose would be worse than doing nothing.
  assert.equal(skipLabel('x'.repeat(41)), '');
  assert.equal(skipLabel('Advertisement — your video will resume in a few moments, please wait'), '');
});

test('a label at the length limit is still usable', () => {
  const label = 'x'.repeat(40);
  assert.equal(skipLabel(label), label);
});
