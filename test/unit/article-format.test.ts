import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractArticle, fixImageUrls } from '../../src/article/readability.ts';
import { telegraphNodes } from '../../src/article/telegraph.ts';
import type { Http } from '../../src/platform/http.ts';

interface Node {
  tag?: string;
  attrs?: Record<string, string>;
  children?: unknown[];
}

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const PAGE = 'https://blog.example.test/formatted';
const http: Http = async (url) => ({ status: 200, url, contentType: 'text/html', body: fixture('formatted.html') });

/** One extraction for every test: Readability is the slow part, and the page never changes. */
let converted: Promise<{ html: string; nodes: Node[] }> | null = null;
function formatTestPage(): Promise<{ html: string; nodes: Node[] }> {
  converted ??= extractArticle(http, PAGE).then((article) => ({ html: article.html, nodes: telegraphNodes(article.html) as Node[] }));
  return converted;
}

const text = (node: Node): string =>
  (node.children ?? []).map((child) => (typeof child === 'string' ? child : text(child as Node))).join('');

function walk(nodes: unknown[], visit: (node: Node) => void): void {
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    visit(node as Node);
    walk((node as Node).children ?? [], visit);
  }
}

/** The single strongest check: anything else would be silently dropped by Telegra.ph. */
const TELEGRAPH_TAGS = new Set([
  'a', 'aside', 'b', 'blockquote', 'br', 'code', 'em', 'figcaption', 'figure', 'h3', 'h4', 'hr',
  'i', 'iframe', 'img', 'li', 'ol', 'p', 'pre', 's', 'strong', 'u', 'ul', 'video',
]);

test('Article formatting: extraction keeps the heading, table, quote, code, video and embed', async () => {
  const { html } = await formatTestPage();

  assert.match(html, /<h2>Headings keep their rank<\/h2>/, 'a second-level heading is no longer stripped');
  assert.match(html, /<table>/, 'a table reaches the converter instead of leaving glued text');
  assert.match(html, /<blockquote>/, 'quotes survive sanitizing');
  assert.match(html, /<pre><code>function greet/, 'code keeps its block and its wrapper');
  assert.match(html, /<video src="https:\/\/blog\.example\.test\/media\/clip\.mp4">/, 'the <source> file becomes the video src');
  assert.match(html, /<iframe src="https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ">/, 'an embed keeps its absolute src');
  assert.match(html, /<a href="https:\/\/blog\.example\.test\/guides\/instant-view">/, 'a relative link is resolved against the publisher');
});

test('Article formatting: six heading levels collapse onto the two Telegra.ph has', async () => {
  const { nodes } = await formatTestPage();
  const heading = (label: string): Node | undefined => {
    let found: Node | undefined;
    walk(nodes, (node) => {
      if ((node.tag === 'h3' || node.tag === 'h4') && text(node) === label) found = node;
    });
    return found;
  };

  assert.equal(heading('Headings keep their rank')?.tag, 'h3', 'h2 becomes h3');
  assert.equal(heading('Third level')?.tag, 'h3', 'h3 stays h3');
  assert.equal(heading('Fourth level')?.tag, 'h4', 'h4 stays h4');
  assert.equal(heading('Fifth level')?.tag, 'h4', 'h5 becomes h4 instead of bare text');
  assert.equal(heading('Sixth level')?.tag, 'h4', 'h6 becomes h4 instead of bare text');
});

test('Article formatting: a paragraph keeps emphasis, code and its link', async () => {
  const { nodes } = await formatTestPage();
  const paragraph = nodes.find((node) => node.tag === 'p' && text(node).startsWith('Every blog post'));
  assert.ok(paragraph, 'the opening paragraph is a paragraph node');

  const inner: string[] = [];
  walk(paragraph.children ?? [], (node) => node.tag && inner.push(node.tag));
  assert.deepEqual(inner.filter((tag) => tag !== 'a'), ['b', 'i', 's', 'code'], 'bold, italic, strikethrough and inline code survive in order');

  const link = JSON.stringify(paragraph);
  assert.match(link, /"tag":"a","attrs":\{"href":"https:\/\/blog\.example\.test\/guides\/instant-view"\}/, 'the link keeps an absolute href');
});

test('Article formatting: lists keep their markers and nesting without paragraph wrappers', async () => {
  const { nodes } = await formatTestPage();
  const bullet = nodes.find((node) => node.tag === 'ul');
  const numbered = nodes.find((node) => node.tag === 'ol');
  assert.ok(bullet && numbered, 'both list kinds survive');

  const items = (bullet.children ?? []) as Node[];
  assert.equal(items.length, 3, 'each source <li> is one list item');
  assert.ok(JSON.stringify(bullet).includes('"tag":"ul"'), 'the nested list is still a list');
  assert.doesNotMatch(JSON.stringify(bullet), /"tag":"p"/, 'a paragraph inside a list item is unwrapped');
  assert.match(text(items[0] as Node), /First bullet with a link/, 'the item text and its link are kept');

  const steps = (numbered.children ?? []) as Node[];
  assert.deepEqual(steps.map(text), ['Step one', 'Step two', 'Step three']);
});

test('Article formatting: a quote stays one blockquote with line breaks, not nested paragraphs', async () => {
  const { nodes } = await formatTestPage();
  const quote = nodes.find((node) => node.tag === 'blockquote');
  assert.ok(quote, 'the quote is published');

  const json = JSON.stringify(quote);
  assert.doesNotMatch(json, /"tag":"p"/, 'IV\'s blockquote holds rich text, not paragraphs');
  assert.match(json, /"tag":"br"/, 'the second paragraph starts on a new line');
  assert.match(text(quote), /A quote that spans two paragraphs must stay one quote\./, 'the first paragraph is kept');
  assert.match(text(quote), /• a quoted list item/, 'a list inside the quote becomes a marked line');
});

test('Article formatting: a code block keeps every line and its indentation', async () => {
  const { nodes } = await formatTestPage();
  const pre = nodes.find((node) => node.tag === 'pre');
  assert.ok(pre);

  assert.equal(pre.children?.[0], 'function greet(name) {\n  const message = `hello ${name}`;\n  return message;\n}', 'newlines and spaces are untouched');
  assert.doesNotMatch(JSON.stringify(pre), /"tag":"code"/, 'the inner <code> is unwrapped: pre is already monospace');
});

test('Article formatting: a table becomes one paragraph per row with a bold header', async () => {
  const { nodes } = await formatTestPage();
  const json = JSON.stringify(nodes);
  assert.doesNotMatch(json, /"tag":"table"/, 'Telegra.ph has no table node');

  const rows = nodes.filter((node) => node.tag === 'p' && text(node).includes(' | ')).map(text);
  assert.deepEqual(rows, ['Plan | Price | Limit', 'Free | $0 | 3 sources', 'Pro | $5 | 50 sources', 'Gift |  | included'], 'every row is one readable line and a picture-only cell keeps its column');
  assert.match(json, /"tag":"b","children":\["Plan"\]/, 'header cells stay bold');
  assert.match(json, /"tag":"b","children":\["Delivery options"\]/, 'the table caption is kept');
});

test('Article formatting: images become figures, captions survive and an inline picture splits its paragraph', async () => {
  const { nodes } = await formatTestPage();
  const figures: Node[] = [];
  walk(nodes, (node) => {
    if (node.tag === 'figure') figures.push(node);
  });
  const figure = (src: string): Node | undefined => figures.find((node) => JSON.stringify(node).includes(src));

  assert.equal(figures.length, 6, 'every picture gets a figure of its own');
  assert.match(JSON.stringify(figure('hero.jpg')), /"src":"https:\/\/blog\.example\.test\/images\/hero\.jpg"/, 'a relative image source is absolute');
  assert.match(JSON.stringify(figure('hero.jpg')), /"tag":"figcaption","children":\["The hero picture, captioned\."\]/, 'a figcaption is kept');
  assert.match(JSON.stringify(figure('second.jpg')), /"tag":"figcaption","children":\["A caption written as a paragraph\."\]/, 'a caption written as <p> is promoted');

  const inline = nodes.findIndex((node) => JSON.stringify(node).includes('inline-hero.jpg'));
  assert.equal(text(nodes[inline - 1] as Node), 'An inline picture', 'the paragraph before the picture keeps its words');
  assert.equal(text(nodes[inline + 1] as Node), 'splits the paragraph around it.', 'the paragraph after the picture keeps its words');
});

test('Article formatting: media inside a paragraph, a list item, a quote or a cell is never lost', async () => {
  const { nodes } = await formatTestPage();
  const json = JSON.stringify(nodes);

  assert.match(json, /"tag":"figure","children":\[\{"tag":"img","attrs":\{"src":"https:\/\/blog\.example\.test\/images\/list-photo\.jpg"/, 'a picture inside a list item becomes a figure');
  assert.match(json, /quote\.jpg/, 'a picture inside a quote is published next to it');
  assert.match(json, /gift\.jpg/, 'a picture inside a table cell is published next to its row');
  assert.match(json, /"tag":"iframe","attrs":\{"src":"https:\/\/www\.youtube\.com\/embed\/inline-frame"\}/, 'an embed inside a paragraph survives');
});

test('Article formatting: video, embed, divider and text from a stripped container all reach the page', async () => {
  const { nodes } = await formatTestPage();
  const json = JSON.stringify(nodes);

  assert.match(json, /"tag":"video","attrs":\{"src":"https:\/\/blog\.example\.test\/media\/clip\.mp4"\}/, 'the clip is playable in IV');
  assert.match(json, /"tag":"iframe","attrs":\{"src":"https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ"\}/, 'the embed is kept');
  assert.match(json, /"tag":"hr"/, 'the divider survives');
  assert.ok(nodes.some((node) => node.tag === 'p' && text(node) === 'Loose text in a container still becomes a paragraph.'), 'the sanitizer strips the <div>, not the words');
});

test('Article formatting: every node is one Telegra.ph accepts, and none is empty', async () => {
  const { nodes } = await formatTestPage();
  const seen = new Set<string>();

  walk(nodes, (node) => {
    assert.ok(node.tag !== undefined, 'a node without a tag is a bare string');
    seen.add(node.tag as string);
    if (node.tag === 'p' || node.tag === 'li' || node.tag === 'blockquote' || node.tag === 'pre') {
      assert.ok((node.children?.length ?? 0) > 0, `an empty <${node.tag}> is noise`);
    }
  });

  for (const tag of seen) assert.ok(TELEGRAPH_TAGS.has(tag), `<${tag}> is not a Telegra.ph node`);
  assert.ok(nodes.every((node) => typeof node !== 'string'), 'the article body is a list of blocks');
});

test('Article formatting: links, embeds and videos are made absolute before Telegra.ph sees them', () => {
  const fixed = fixImageUrls(
    '<p><a href="/one">one</a> <a href="#top">top</a> <a href="mailto:hi@example.test">mail</a></p>' +
      '<video><source src="/clip.mp4"></video><iframe src="/embed/1"></iframe>',
    'https://blog.example.test/story',
  );

  assert.match(fixed, /<a href="https:\/\/blog\.example\.test\/one">one<\/a>/, 'a relative link would resolve against telegra.ph');
  assert.match(fixed, /<a>top<\/a>/, 'a fragment has no target on the Telegraph page');
  assert.match(fixed, /<a>mail<\/a>/, 'mailto is not an Instant View link');
  assert.match(fixed, /<video src="https:\/\/blog\.example\.test\/clip\.mp4">/, 'the source inside <video> is promoted to src');
  assert.match(fixed, /<iframe src="https:\/\/blog\.example\.test\/embed\/1">/, 'an embed src is absolute too');
});

test('Article formatting: a nested table is flattened once, and a stripped container still yields a paragraph', () => {
  const nested = telegraphNodes('<table><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>');
  const body = JSON.stringify(nested);
  assert.equal(body.match(/inner/g)?.length, 1, 'the inner row is not emitted twice');

  assert.deepEqual(telegraphNodes('<div>Loose text</div>'), [{ tag: 'p', children: ['Loose text'] }], 'a container is unwrapped, its words are kept');
  assert.deepEqual(
    telegraphNodes('<p>Before <span>inline wrapper</span> after</p>'),
    [{ tag: 'p', children: ['Before ', 'inline wrapper', ' after'] }],
    'an inline wrapper adds no line break',
  );
});
