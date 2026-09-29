// A small Markdown renderer for Duel Lens's own pages: the legal texts (copy.ts), the privacy policy
// and the third-party notices (src/legal). It builds Preact elements, never an HTML string, so a
// document can't inject markup, and only web, mailto, #anchor and relative links become links.
// It covers what those documents use: headings (with GitHub's ids, which the notices' contents link
// to), paragraphs (a line break stays one), bullet and numbered lists nested by indentation, tables,
// fenced code, block quotes, rules, **bold**, *italic*, `code`, [links](url) and <https://autolinks>.
// HTML comments are dropped.
import type { ComponentChildren } from 'preact';

const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|<((?:https?:\/\/|mailto:)[^>\s]+)>/g;

/** A link target Duel Lens may follow: web, mailto, an #anchor, or a relative path (its own pages). */
function safeHref(href: string): string | null {
  if (/^(https?:\/\/|mailto:|#)/i.test(href)) return href;
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') ? null : href;
}

function link(href: string, children: ComponentChildren, key: number) {
  const safe = safeHref(href);
  if (!safe) return <span key={key}>{children}</span>;
  return /^https?:/i.test(safe) ? (
    <a key={key} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <a key={key} href={safe}>
      {children}
    </a>
  );
}

/** One line of Markdown text as Preact children. */
function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, code, bold, em, label, href, auto] = m;
    const key = out.length;
    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (bold !== undefined) out.push(<b key={key}>{inline(bold)}</b>);
    else if (em !== undefined) out.push(<em key={key}>{inline(em)}</em>);
    else if (label !== undefined) out.push(link(href, inline(label), key));
    else out.push(link(auto, auto, key));
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines of one paragraph, their line breaks kept. */
function lines(text: string): ComponentChildren[] {
  return text.split('\n').flatMap((line, i) => (i === 0 ? inline(line) : [<br key={`br${i}`} />, ...inline(line)]));
}

/** A line of Markdown text (bold, italic, code, links), e.g. a legal sentence from copy.ts. */
export function Rich({ text }: { text: string }) {
  return <>{inline(text)}</>;
}

/** Heading text without its Markdown: what GitHub makes the heading's id from. */
const headingText = (text: string) =>
  text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');

/** GitHub's heading id: lower case, punctuation dropped, spaces to hyphens ("9.1 Apache License 2.0" → "91-apache-license-20"). */
export function headingId(text: string): string {
  return headingText(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; start: number; items: { text: string; children: Block[] }[] };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isTableStart = (all: string[], i: number) => all[i].trimStart().startsWith('|') && TABLE_SEPARATOR.test(all[i + 1] ?? '');
const startsBlock = (all: string[], i: number) =>
  FENCE.test(all[i]) || HEADING.test(all[i]) || RULE.test(all[i]) || ITEM.test(all[i]) || QUOTE.test(all[i]) || isTableStart(all, i);

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** The list whose first item is at all[i], with its items' nested lists; returns where it ends. */
function parseList(all: string[], i: number): { block: Block; next: number } {
  const first = ITEM.exec(all[i])!;
  const indent = first[1].length;
  const ordered = first[3] !== undefined;
  const items: { text: string; children: Block[] }[] = [];
  while (i < all.length) {
    const m = ITEM.exec(all[i]);
    if (!m || m[1].length !== indent || (m[3] !== undefined) !== ordered) break;
    let text = m[4];
    const nested: string[] = [];
    i++;
    // The item's own lines: indented deeper than its marker (nested lists, continued text).
    while (i < all.length && all[i].trim() !== '' && indentOf(all[i]) > indent) {
      if (nested.length === 0 && !ITEM.test(all[i])) text += `\n${all[i].trim()}`;
      else nested.push(all[i]);
      i++;
    }
    items.push({ text, children: nested.length ? parseBlocks(nested) : [] });
  }
  return { block: { kind: 'list', ordered, start: ordered ? Number(first[3]) : 1, items }, next: i };
}

function parseBlocks(all: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < all.length) {
    const line = all[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      for (i++; i < all.length && !FENCE.test(all[i]); i++) body.push(all[i]);
      blocks.push({ kind: 'code', text: body.join('\n') });
      i++; // the closing fence
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (isTableStart(all, i)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < all.length && all[i].trimStart().startsWith('|'); i++) rows.push(cells(all[i]));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < all.length && QUOTE.test(all[i]); i++) inner.push(QUOTE.exec(all[i])![1]);
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner) });
      continue;
    }
    if (ITEM.test(line)) {
      const { block, next } = parseList(all, i);
      blocks.push(block);
      i = next;
      continue;
    }
    const text: string[] = [line.trim()];
    for (i++; i < all.length && all[i].trim() !== '' && !startsBlock(all, i); i++) text.push(all[i].trim());
    blocks.push({ kind: 'paragraph', text: text.join('\n') });
  }
  return blocks;
}

function renderBlocks(blocks: Block[], ids: Map<string, number>): ComponentChildren[] {
  return blocks.map((b, key) => {
    switch (b.kind) {
      case 'heading': {
        // GitHub numbers repeated ids: "notes", "notes-1", …
        const base = headingId(b.text);
        const seen = ids.get(base) ?? 0;
        ids.set(base, seen + 1);
        const Tag = `h${Math.min(b.level, 6)}` as 'h1';
        return (
          <Tag key={key} id={seen ? `${base}-${seen}` : base}>
            {inline(b.text)}
          </Tag>
        );
      }
      case 'paragraph':
        return <p key={key}>{lines(b.text)}</p>;
      case 'code':
        return (
          <pre key={key}>
            <code>{b.text}</code>
          </pre>
        );
      case 'rule':
        return <hr key={key} />;
      case 'quote':
        return <blockquote key={key}>{renderBlocks(b.blocks, ids)}</blockquote>;
      case 'table':
        return (
          <div key={key} class="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, i) => (
                    <th key={i}>{inline(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, i) => (
                      <td key={i}>{inline(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const items = b.items.map((item, i) => (
          <li key={i}>
            {lines(item.text)}
            {renderBlocks(item.children, ids)}
          </li>
        ));
        return b.ordered ? (
          <ol key={key} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
    }
  });
}

/** A Markdown document as Preact elements (HTML comments dropped). */
export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n').split('\n'));
  return <>{renderBlocks(blocks, new Map())}</>;
}
