/**
 * A small markdown parser for chat replies.
 *
 * The original terminal forbade markdown because Nuklear drew glyphs, not
 * documents — a `**bold**` reached the user as four asterisks. This view can
 * draw it, so the model is allowed to use it and this turns it into structure.
 *
 * Parsing to plain objects rather than to HTML is deliberate. The renderer
 * builds DOM nodes from these, so model output never touches `innerHTML` and a
 * reply containing markup is displayed, not executed.
 *
 * The subset is what a chat reply actually uses: headings, paragraphs, fenced
 * and inline code, emphasis, links, lists and quotes.
 */

/**
 * Inline spans, in the order the scanner tries them.
 *
 * Emphasis requires its delimiters to hug the text — `\S` on both inside edges
 * — because otherwise `2 * 3 * 4 = 24` comes out italicised, which is arithmetic
 * turned into formatting. The underscore forms additionally refuse to fire
 * inside a word, so `snake_case_name` survives intact.
 */
const INLINE = [
  { type: 'code', re: /`([^`\n]+)`/y },
  { type: 'link', re: /\[([^\]\n]*)\]\(([^)\s]+)\)/y },
  { type: 'bold', re: /\*\*(\S(?:[^*\n]*\S)?)\*\*/y },
  { type: 'bold', re: /(?<!\w)__(\S(?:[^_\n]*\S)?)__(?!\w)/y },
  { type: 'italic', re: /\*(\S(?:[^*\n]*\S)?)\*/y },
  { type: 'italic', re: /(?<!\w)_(\S(?:[^_\n]*\S)?)_(?!\w)/y },
];

/** Only links we would be willing to open. */
function safeHref(href) {
  return /^https?:\/\//i.test(href) ? href : '';
}

/**
 * Split one line into inline spans.
 *
 * Code is matched first so emphasis markers inside it stay literal — `**` in a
 * code span is part of the code, not a styling instruction.
 */
export function parseInline(text) {
  const source = String(text ?? '');
  const spans = [];
  let plain = '';
  let i = 0;

  const flush = () => {
    if (plain) spans.push({ type: 'text', text: plain });
    plain = '';
  };

  while (i < source.length) {
    let matched = false;

    for (const { type, re } of INLINE) {
      re.lastIndex = i;
      const match = re.exec(source);
      if (!match) continue;

      if (type === 'link') {
        const href = safeHref(match[2]);
        // A link we will not open is kept as its own text rather than dropped:
        // losing the words would be worse than losing the link.
        if (!href) continue;
        flush();
        spans.push({ type: 'link', text: match[1] || href, href });
      } else {
        flush();
        spans.push({ type, text: match[1] });
      }

      i = re.lastIndex;
      matched = true;
      break;
    }

    if (!matched) {
      plain += source[i];
      i += 1;
    }
  }

  flush();
  return spans;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```(\w*)\s*$/;

/**
 * Parse a reply into blocks.
 *
 * Returns `[{type, ...}]` where every text-bearing block carries `inline`
 * spans. Unknown syntax is left as text, which is the right failure for a chat:
 * showing the characters is never worse than swallowing them.
 */
export function parseMarkdown(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];

  let paragraph = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  let list = null;
  const endList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      endList();
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      endParagraph();
      endList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      endList();
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      endParagraph();
      endList();
      blocks.push({ type: 'quote', inline: parseInline(quote[1]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        endList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(parseInline((bullet ?? numbered)[1]));
      continue;
    }

    endList();
    paragraph.push(line);
  }

  endParagraph();
  endList();
  return blocks;
}
