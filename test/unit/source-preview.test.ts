/**
 * S4 — the Add Source preview promises the five newest posts (§5.4). A photo caption is capped at
 * 1024 characters, so the list used to be cut — and the posts after the cut simply disappeared.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryOptionsView } from '../../src/bot/screens/delivery-options.ts';
import { sourcePreviewView } from '../../src/bot/screens/source-preview.ts';
import { LANGS } from '../../src/bot/i18n/index.ts';
import type { Platform } from '../../src/platform/registry.ts';
import type { FeedItem } from '../../src/platform/feed/native.ts';
import { CAPTION_LIMIT } from '../../src/telegram/api.ts';

/** Every platform the picker can add; `rss` stands for a blog or a category page. */
const PLATFORMS: Platform[] = ['instagram', 'x', 'tiktok', 'threads', 'youtube', 'tumblr', 'facebook', 'bluesky', 'snapchat', 'pinterest', 'rss'];

/** Five newest, oldest first, exactly as `newest()` hands them over. */
const items = (title: (index: number) => string): FeedItem[] =>
  Array.from({ length: 5 }, (_, index) => ({
    guid: `g${index}`,
    link: `https://example.test/p/${index}`,
    title: title(index),
    publishedAt: Date.UTC(2026, 10, 1 + index, 9, 0),
    summary: null,
    media: [],
  }));

const bullets = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('• '));

const view = (platform: Platform, list: FeedItem[], lang = 'en' as const): { text: string; photoUrl: string | null } =>
  sourcePreviewView({ platform, author: 'Someone', avatarUrl: 'https://cdn.test/avatar.jpg', items: list, personalChatId: 1, chats: [], lang });

test('S4: five posts survive the caption cap on every platform', () => {
  for (const platform of PLATFORMS) {
    // The longest title a real feed ships: RSSHub cuts an Instagram caption at 153 characters.
    const { text } = view(platform, items((index) => `Post ${index} ${'caption '.repeat(18)}`.trim().slice(0, 153)));
    const lines = bullets(text);

    assert.equal(lines.length, 5, `${platform} lists five posts:\n${text}`);
    assert.ok(text.length <= CAPTION_LIMIT, `${platform} keeps the caption at ${text.length} chars`);
    assert.ok(!text.endsWith('…'), `${platform} keeps the question, not a cut list:\n${text}`);
  }
});

test('S4: one very long title cannot push the other four out of the preview', () => {
  for (const platform of PLATFORMS) {
    const { text } = view(platform, items((index) => (index === 0 ? 'x'.repeat(800) : `Post ${index}`)));
    const lines = bullets(text);

    assert.equal(lines.length, 5, `${platform} still lists five posts:\n${text}`);
    assert.ok(text.length <= CAPTION_LIMIT, `${platform} stays under the cap`);
    assert.ok((lines[0]?.length ?? 0) <= 130, `${platform} shortens the long title to one line`);
    assert.match(lines[4] ?? '', /Post 4/, 'the newest post is still the last line');
  }
});

test('S4: the caption fits with the longest question of every language', () => {
  for (const lang of LANGS) {
    const { text } = view('instagram', items((index) => `Post ${index} ${'caption '.repeat(18)}`.trim().slice(0, 153)), lang);
    assert.ok(text.length <= CAPTION_LIMIT, `${lang} caption is ${text.length} chars`);
    assert.equal(bullets(text).length, 5, `${lang} keeps all five`);
  }
});

test('S5: the add-question screen still holds the same five posts', () => {
  const { text } = view('tiktok', items((index) => `Post ${index} ${'caption '.repeat(18)}`.trim().slice(0, 153)));
  const body = text.split('\n\n').slice(0, -2).join('\n\n');
  const options = deliveryOptionsView(body, 'en', [], null);

  assert.equal(bullets(options.text).length, 5);
  assert.ok(options.text.length <= CAPTION_LIMIT, `S5 is ${options.text.length} chars`);
});
