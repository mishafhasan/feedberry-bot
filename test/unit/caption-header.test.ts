import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSource } from '../../src/platform/registry.ts';
import { postHeader, sourceName, ddmmhhmm } from '../../src/render/caption.ts';
import { platformIcon } from '../../src/platform/icons.ts';
import { platformIcon as platformIconViaTexts } from '../../src/bot/texts.ts';

/** ARCHITECTURE §8.2: one label per source type, spelled the way the platform itself spells it. */
const LABELS: Array<[string, string]> = [
  ['rss', 'RSS'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['threads', 'Threads'],
  ['youtube', 'YouTube'],
  ['tiktok', 'TikTok'],
  ['x', 'X'],
  ['tumblr', 'Tumblr'],
  ['pinterest', 'Pinterest'],
  ['bluesky', 'Bluesky'],
  ['telegram', 'Telegram'],
  ['snapchat', 'Snapchat'],
];

/** One real link per supported source type, and the label its caption must print. */
const SOURCES: Array<[string, string]> = [
  ['https://www.wired.com/story/wired-world-fair-2026-cj-pearson-and-kat-abughazaleh/', 'RSS'],
  ['https://www.instagram.com/evolving.ai', 'Instagram'],
  ['https://www.facebook.com/reel/1597277074976135/', 'Facebook'],
  ['https://www.threads.net/@zuck/post/Cabc', 'Threads'],
  ['https://www.youtube.com/@CeylonFocusNews', 'YouTube'],
  ['https://www.tiktok.com/@demo/video/1', 'TikTok'],
  ['https://x.com/blue/status/123', 'X'],
  ['https://blog.tumblr.com/post/123', 'Tumblr'],
  ['https://www.pinterest.com/pin/1149614242378622706/', 'Pinterest'],
  ['https://bsky.app/profile/demo.bsky.social/post/1', 'Bluesky'],
  ['https://t.me/durov', 'Telegram'],
];

const detectOpts = { rsshubBase: 'http://rsshub.test', telegramBeta: true };

test('caption header: the label is what stage 1 detected, for every supported source', () => {
  for (const [link, label] of SOURCES) {
    const ref = detectSource(link, detectOpts);
    const header = postHeader({ sourceTitle: 'Demo', url: link, publishedAt: null, platform: ref.platform });
    assert.equal(header, `🌐 <a href="${link}">Demo</a> | ${label}`, link);
  }
});

test('caption header: every source type ends the linked line with its own platform', () => {
  for (const [platform, label] of LABELS) {
    const header = postHeader({ sourceTitle: 'Hiru News', url: 'https://facebook.com/reel/1597277074976135', publishedAt: null, platform });
    assert.equal(header, `🌐 <a href="https://facebook.com/reel/1597277074976135">Hiru News</a> | ${label}`, platform);
  }
});

/** RSSHub decorates its channel titles with the platform; the label already prints it. */
const DECORATED: Array<[string, string, string]> = [
  ['Evolving AI (@evolving.ai) - Instagram', 'instagram', 'Evolving AI (@evolving.ai)'],
  ['Mark Zuckerberg (@zuck) on Threads', 'threads', 'Mark Zuckerberg (@zuck)'],
  ['Josim (josimabout) - Profile | Pinterest', 'pinterest', 'Josim (josimabout)'],
  ['Twitter @strike', 'x', '@strike'],
  ['Hiru News', 'facebook', 'Hiru News'],
  ['The Verge', 'rss', 'The Verge'],
  ['Life on Threads', 'rss', 'Life on Threads'],
  ['Instagram', 'instagram', 'Instagram'],
];

test('caption header: the source name drops the platform the label already names', () => {
  for (const [title, platform, name] of DECORATED) {
    assert.equal(sourceName(title, platform), name, title);
  }
  assert.equal(
    postHeader({ sourceTitle: 'Evolving AI (@evolving.ai) - Instagram', url: null, publishedAt: null, platform: 'instagram' }),
    '🌐 Evolving AI (@evolving.ai) | Instagram',
    'the header prints the platform once',
  );
});

test('caption header: the label is the source type, not the domain, and the time keeps its own line', () => {
  // A blog on a custom domain is an RSS source; nothing about wired.com says RSS.
  const header = postHeader({
    sourceTitle: 'WIRED',
    url: 'https://www.wired.com/story/wired-world-fair-2026/',
    publishedAt: Date.UTC(2026, 10, 1, 4, 1),
    platform: 'rss',
  });

  assert.equal(header, '🌐 <a href="https://www.wired.com/story/wired-world-fair-2026/">WIRED</a> | RSS\n⏱️ Time: 11/01 04:01');
  assert.equal(postHeader({ sourceTitle: null, url: null, publishedAt: null, platform: 'rss' }), '🌐 Source | RSS', 'an unnamed source still names the platform');
  assert.equal(
    postHeader({ sourceTitle: 'X', url: null, publishedAt: null, platform: 'constructor' }),
    '🌐 X | constructor',
    'a value the map does not own prints as itself, never as Object.prototype’s',
  );
});

test('rich header: the platform logo leads and the time is day-first in the reader zone (ADR-023)', () => {
  const header = postHeader({
    sourceTitle: 'WIRED',
    url: 'https://www.wired.com/story/x/',
    publishedAt: Date.UTC(2026, 10, 1, 4, 1),
    platform: 'instagram',
    tz: 'Asia/Dhaka',
    rich: true,
  });
  assert.equal(header, `${platformIcon('instagram')} <a href="https://www.wired.com/story/x/">WIRED</a> | Instagram\n⏱️ Time: 01/11 10:01`);
  assert.equal(ddmmhhmm(Date.UTC(2026, 10, 1, 4, 1)), '01/11 04:01', 'UTC stays the default zone');
});

test('icons: the bot layer re-exports the one producer in platform/icons', () => {
  assert.equal(platformIconViaTexts('x'), platformIcon('x'));
  assert.match(platformIcon('x'), /^<tg-emoji emoji-id="\d+">✖️<\/tg-emoji>$/);
});
