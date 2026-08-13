/**
 * The markdown parser.
 *
 * It exists because the model's output is now rendered rather than shown
 * literally — which also means a reply containing markup must come out as
 * *data* the renderer draws, never as HTML it executes. The parser returning
 * plain objects is what guarantees that, so the shapes are pinned here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown } from '../src/shared/markdown.mjs';

const kinds = (blocks) => blocks.map((b) => b.type);
const flat = (spans) => spans.map((s) => `${s.type}:${s.text}`).join('|');

/* ============================ inline ============================ */

test('plain text is one span', () => {
  assert.deepEqual(parseInline('just words'), [{ type: 'text', text: 'just words' }]);
});

test('emphasis and code become their own spans', () => {
  assert.equal(flat(parseInline('a **bold** and *italic* and `code`')), 'text:a |bold:bold|text: and |italic:italic|text: and |code:code');
});

test('underscores work for emphasis too', () => {
  assert.equal(flat(parseInline('__strong__ and _slanted_')), 'bold:strong|text: and |italic:slanted');
});

test('markers inside code stay literal', () => {
  // The whole reason code is matched first.
  assert.equal(flat(parseInline('use `a ** b` here')), 'text:use |code:a ** b|text: here');
});

test('a link keeps its text and target', () => {
  const [span] = parseInline('[the docs](https://example.com/x)');
  assert.deepEqual(span, { type: 'link', text: 'the docs', href: 'https://example.com/x' });
});

test('a link with no text falls back to its URL', () => {
  assert.equal(parseInline('[](https://example.com)')[0].text, 'https://example.com');
});

test('only http links are turned into links', () => {
  // A `javascript:` URL must never become something clickable.
  for (const source of ['[x](javascript:alert(1))', '[x](file:///etc/passwd)', '[x](data:text/html,hi)']) {
    const spans = parseInline(source);
    assert.equal(spans.some((s) => s.type === 'link'), false, source);
    // The words survive as text rather than vanishing.
    assert.match(spans.map((s) => s.text).join(''), /x/);
  }
});

test('arithmetic is not mistaken for emphasis', () => {
  // Markers with whitespace inside them are not emphasis; an earlier version
  // italicised the middle of `2 * 3 * 4 = 24`.
  assert.equal(flat(parseInline('2 * 3 * 4 = 24')), 'text:2 * 3 * 4 = 24');
  assert.equal(flat(parseInline('a ** b')), 'text:a ** b');
  assert.equal(flat(parseInline('* leading star')), 'text:* leading star');
});

test('emphasis still works when it hugs its text', () => {
  assert.equal(flat(parseInline('2 *times* 3')), 'text:2 |italic:times|text: 3');
  assert.equal(flat(parseInline('**all of it**')), 'bold:all of it');
});

test('underscores inside a word are left alone', () => {
  // `snake_case_name` is an identifier, not emphasis.
  assert.equal(flat(parseInline('snake_case_name')), 'text:snake_case_name');
  assert.equal(flat(parseInline('call read_file_now()')), 'text:call read_file_now()');
});

/* ============================ blocks ============================ */

test('paragraphs split on blank lines', () => {
  const blocks = parseMarkdown('first para\nstill first\n\nsecond para');
  assert.deepEqual(kinds(blocks), ['paragraph', 'paragraph']);
  assert.equal(blocks[0].inline[0].text, 'first para\nstill first');
});

test('headings carry their level', () => {
  const blocks = parseMarkdown('# One\n\n### Three');
  assert.deepEqual(kinds(blocks), ['heading', 'heading']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].level, 3);
});

test('a fenced block keeps its text verbatim', () => {
  const blocks = parseMarkdown('before\n\n```js\nconst a = **1**;\n  indented\n```\n\nafter');
  assert.deepEqual(kinds(blocks), ['paragraph', 'code', 'paragraph']);
  assert.equal(blocks[1].lang, 'js');
  // Markdown inside a code fence is not markdown.
  assert.equal(blocks[1].text, 'const a = **1**;\n  indented');
});

test('an unclosed fence still yields a code block', () => {
  const blocks = parseMarkdown('```\nstuck open');
  assert.deepEqual(kinds(blocks), ['code']);
  assert.equal(blocks[0].text, 'stuck open');
});

test('bullets collect into one list', () => {
  const blocks = parseMarkdown('- one\n- two\n* three');
  assert.deepEqual(kinds(blocks), ['list']);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 3);
});

test('numbered items make an ordered list', () => {
  const blocks = parseMarkdown('1. first\n2) second');
  assert.equal(blocks[0].ordered, true);
  assert.equal(blocks[0].items.length, 2);
});

test('changing list style starts a new list', () => {
  const blocks = parseMarkdown('- bullet\n1. numbered');
  assert.deepEqual(kinds(blocks), ['list', 'list']);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[1].ordered, true);
});

test('quotes are their own block', () => {
  const blocks = parseMarkdown('> quoted line');
  assert.deepEqual(kinds(blocks), ['quote']);
  assert.equal(blocks[0].inline[0].text, 'quoted line');
});

test('list items carry inline formatting', () => {
  const blocks = parseMarkdown('- a `snippet` and **weight**');
  assert.equal(flat(blocks[0].items[0]), 'text:a |code:snippet|text: and |bold:weight');
});

test('empty input yields no blocks', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   \n\n  '), []);
  assert.deepEqual(parseMarkdown(null), []);
});

test('markup in a reply is data, not structure', () => {
  // The parser never emits HTML, so a reply containing tags is displayed.
  const blocks = parseMarkdown('<img src=x onerror=alert(1)>');
  assert.deepEqual(kinds(blocks), ['paragraph']);
  assert.equal(blocks[0].inline[0].type, 'text');
  assert.equal(blocks[0].inline[0].text, '<img src=x onerror=alert(1)>');
});

test('a plain reply survives unchanged', () => {
  const text = 'Я відкрив пошук на YouTube. Напишіть точну назву треку.';
  const blocks = parseMarkdown(text);
  assert.deepEqual(kinds(blocks), ['paragraph']);
  assert.equal(blocks[0].inline.map((s) => s.text).join(''), text);
});
