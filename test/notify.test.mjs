/**
 * The one message with no question in front of it.
 *
 * Every other thing this app says is an answer. A notice is not, which is why it
 * has a service of its own — and why the interesting cases are all about what
 * happens when nobody is listening yet, or when a plugin will not stop talking.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Notifier } from '../src/main/notify.mjs';

test('a notice carries what it needs and reaches whoever is listening', () => {
  const notifier = new Notifier();
  const heard = [];
  notifier.on('notice', (notice) => heard.push(notice));

  const notice = notifier.show({ title: '  Watch the series  ', body: 'Due at 18:45', pluginId: 'reminders' });
  assert.equal(notice.title, 'Watch the series');
  assert.equal(notice.pluginId, 'reminders');
  assert.equal(notice.desktop, true, 'a notice arrives on the desktop unless it says otherwise');
  assert.ok(notice.at > 0);
  assert.deepEqual(heard, [notice]);
});

test('two notices in the same millisecond are still two notices', () => {
  // The renderer skips a notice whose id it has already drawn — it can arrive
  // both in the boot snapshot and on the event stream — so two sharing an id
  // would mean one of them is never seen.
  const notifier = new Notifier();
  const first = notifier.show({ title: 'one' });
  const second = notifier.show({ title: 'two' });
  assert.notEqual(first.id, second.id);
});

test('a notice with nothing to say is not a notice', () => {
  const notifier = new Notifier();
  assert.equal(notifier.show({ body: 'a body and no title' }), null);
  assert.equal(notifier.show({}), null);
  assert.equal(notifier.recent().length, 0);
});

test('recent notices are kept for a window that was not listening yet', () => {
  // A reminder can come due during boot: the plugin host starts before the
  // renderer has subscribed, and that is exactly the case this whole path exists
  // for — the app was closed, something was missed, say so on the way in.
  const notifier = new Notifier();
  notifier.show({ title: 'missed one' });
  notifier.show({ title: 'missed two' });
  assert.deepEqual(
    notifier.recent().map((notice) => notice.title),
    ['missed one', 'missed two'],
  );
});

test('a plugin in a loop cannot bury the machine in notifications', () => {
  const notifier = new Notifier();
  const complaints = [];
  notifier.on('log', (line) => complaints.push(line));

  const shown = [];
  for (let i = 0; i < 20; i += 1) {
    const notice = notifier.show({ title: `spam ${i}`, pluginId: 'noisy' });
    if (notice) shown.push(notice);
  }
  assert.ok(shown.length > 0, 'the first few are legitimate');
  assert.ok(shown.length < 20, 'and the rest are refused');
  assert.ok(complaints.length > 0, 'a plugin that has started shouting is worth knowing about');

  // The budget is per plugin: one misbehaving plugin must not silence another.
  assert.ok(notifier.show({ title: 'a reminder', pluginId: 'reminders' }));
});

test('switching a plugin off gives it its budget back', () => {
  const notifier = new Notifier();
  for (let i = 0; i < 20; i += 1) notifier.show({ title: `x${i}`, pluginId: 'noisy' });
  assert.equal(notifier.show({ title: 'blocked', pluginId: 'noisy' }), null);

  notifier.releasePlugin('noisy');
  assert.ok(notifier.show({ title: 'allowed again', pluginId: 'noisy' }));
});

test('a title is trimmed to something a notification can show', () => {
  const notifier = new Notifier();
  const notice = notifier.show({ title: 'x'.repeat(500), body: 'y'.repeat(2000) });
  assert.ok(notice.title.length <= 120);
  assert.ok(notice.body.length <= 400);
});
