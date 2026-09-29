// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, Rich, headingId } from './markdown';

afterEach(cleanup);

const html = (el: Element) => el.innerHTML;

describe('Rich (one line of text)', () => {
  it('renders bold, italic and code', () => {
    const { container } = render(<Rich text="**Card data** comes *weekly* from `db.ygoprodeck.com`." />);
    expect(html(container)).toBe('<b>Card data</b> comes <em>weekly</em> from <code>db.ygoprodeck.com</code>.');
  });

  it('opens web links in a new tab, and links to the extension’s own pages in place', () => {
    const { container } = render(<Rich text="From [YGOPRODeck](https://ygoprodeck.com/), see [Options](options.html) or <https://example.org/x>." />);
    const [web, own, auto] = [...container.querySelectorAll('a')];
    expect(web.getAttribute('href')).toBe('https://ygoprodeck.com/');
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.getAttribute('rel')).toBe('noopener noreferrer');
    expect(own.getAttribute('href')).toBe('options.html');
    expect(own.getAttribute('target')).toBeNull();
    expect(auto.textContent).toBe('https://example.org/x');
    expect(auto.getAttribute('href')).toBe('https://example.org/x');
  });

  it('never turns text into markup, and drops links it can’t trust', () => {
    const { container } = render(<Rich text={'<img src=x onerror="alert(1)"> and [click](javascript:alert(1))'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror="alert(1)"> and click');
  });

  it('leaves code alone: no bold or links inside it', () => {
    const { container } = render(<Rich text="`**not bold** [x](y)`" />);
    expect(html(container)).toBe('<code>**not bold** [x](y)</code>');
  });
});

describe('Markdown (a document)', () => {
  it('renders headings with GitHub-style ids, paragraphs with their line breaks, and rules', () => {
    const { container } = render(<Markdown source={'# Title\n\n## 1. The page\n\n**Effective date:** soon\n**Contact:** me\n\n---\n\nEnd.'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('h2')?.id).toBe('1-the-page');
    const [first, last] = [...container.querySelectorAll('p')];
    expect(html(first)).toBe('<b>Effective date:</b> soon<br><b>Contact:</b> me');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(last.textContent).toBe('End.');
  });

  it('renders nested bullet lists, and numbered lists from their first number', () => {
    const src = 'Intro:\n- **Card data.**\n  - Once a week.\n  - If it has changed.\n- Nothing else.\n\n3. third\n4. fourth';
    const { container } = render(<Markdown source={src} />);
    const outer = container.querySelector('ul')!;
    expect([...outer.children].map((li) => li.tagName)).toEqual(['LI', 'LI']);
    expect(outer.querySelector('li ul')?.querySelectorAll('li')).toHaveLength(2);
    expect(outer.children[1].textContent).toBe('Nothing else.');
    const ol = container.querySelector('ol')!;
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders tables with inline formatting in the cells', () => {
    const { container } = render(<Markdown source={'| What | Why |\n|---|---|\n| **Scan history** | `history` in storage |\n| Key | Yours |'} />);
    expect([...container.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['What', 'Why']);
    const cells = [...container.querySelectorAll('tbody td')];
    expect(cells).toHaveLength(4);
    expect(html(cells[0])).toBe('<b>Scan history</b>');
    expect(html(cells[1])).toBe('<code>history</code> in storage');
  });

  it('keeps fenced code as it is, drops HTML comments, and renders block quotes', () => {
    const src = '<!--\nMaintainers: hidden\n-->\n\n```text\n  Licence line 1\n\n  * item, not a list\n```\n\n> quoted **text**';
    const { container } = render(<Markdown source={src} />);
    expect(container.textContent).not.toContain('Maintainers');
    expect(container.querySelector('pre code')?.textContent).toBe('  Licence line 1\n\n  * item, not a list');
    expect(container.querySelector('blockquote b')?.textContent).toBe('text');
  });
});

describe('headingId', () => {
  it('matches GitHub’s anchors, which the notices’ contents link to', () => {
    expect(headingId('1. Summary')).toBe('1-summary');
    expect(headingId('4. WebAssembly: ONNX Runtime Web')).toBe('4-webassembly-onnx-runtime-web');
    expect(headingId('9.1 Apache License 2.0')).toBe('91-apache-license-20');
    expect(headingId('6. Emscripten runtime, musl and LLVM (both WebAssembly builds)')).toBe('6-emscripten-runtime-musl-and-llvm-both-webassembly-builds');
  });

  it('resolves every contents link of THIRD_PARTY_NOTICES.md to a heading of that file', () => {
    const notices = readFileSync(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const { container } = render(<Markdown source={notices} />);
    const targets = [...container.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')!.slice(1));
    expect(targets.length).toBeGreaterThan(8);
    for (const id of targets) expect(container.querySelector(`[id="${id}"]`), `#${id}`).not.toBeNull();
    // Its licence texts stay preformatted, and the maintainers' comment stays out.
    expect(container.querySelectorAll('pre').length).toBeGreaterThan(10);
    expect(container.textContent).not.toContain('Maintainers:');
  });
});
