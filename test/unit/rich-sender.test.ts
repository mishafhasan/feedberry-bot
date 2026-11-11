import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Api } from 'grammy';
import { TelegramSender, senderTarget, plainText } from '../../src/telegram/api.ts';
import { morePayload } from '../../src/telegram/more.ts';
import { fakeBotApi } from '../fake-api.ts';

const photo = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));
const target = senderTarget(42);
const senderFor = (apiRoot: string) => new TelegramSender(new Api('123:fake', { apiRoot }));

test('rich plan: one sendRichMessage, html + uploaded media refs, entity detection off', async () => {
  const api = await fakeBotApi();
  try {
    const html = '<p>header</p><tg-slideshow><img src="tg://photo?id=m0"/></tg-slideshow><p>body</p>';
    const ids = await senderFor(api.apiRoot).send({ kind: 'rich', html, media: [{ id: 'm0', file: photo, kind: 'photo' }] }, target);

    assert.equal(ids.length, 1, 'one message per post');
    const call = api.last('sendRichMessage');
    assert.ok(call);
    assert.equal(call.body.rich_message.html, html);
    assert.equal(call.body.rich_message.skip_entity_detection, true);
    const media = call.body.rich_message.media as Array<{ id: string; media: { type: string; media: string } }>;
    assert.equal(media.length, 1);
    assert.equal(media[0]?.id, 'm0');
    assert.equal(media[0]?.media.type, 'photo');
    assert.match(media[0]?.media.media ?? '', /^attach:\/\//, 'the local file uploads as attach://');
    assert.equal(api.calls.filter((c) => c.method === 'sendMediaGroup').length, 0, 'no attached media group');
    assert.equal(api.calls.filter((c) => c.method === 'sendMessage').length, 0, 'no continuation message');
  } finally {
    await api.close();
  }
});

test('rich plan without media: still one rich message, no media field', async () => {
  const api = await fakeBotApi();
  try {
    const ids = await senderFor(api.apiRoot).send({ kind: 'rich', html: '<p>words only</p>', media: [] }, target);
    assert.equal(ids.length, 1);
    assert.equal(api.last('sendRichMessage')?.body.rich_message.media, undefined);
  } finally {
    await api.close();
  }
});

test('rich plan: a parse failure resends the text plain, never drops the post', async () => {
  const api = await fakeBotApi({}, { failParseOnce: true });
  try {
    const html = '<p>header</p><p>body &amp; more</p>';
    const ids = await senderFor(api.apiRoot).send({ kind: 'rich', html, media: [] }, target);

    assert.equal(ids.length, 1);
    assert.equal(api.calls.filter((c) => c.method === 'sendRichMessage').length, 1, 'the rejected attempt');
    const plain = api.last('sendMessage');
    assert.equal(plain?.body.parse_mode, undefined, 'the fallback is plain text');
    assert.equal(plain?.body.text, plainText(html));
  } finally {
    await api.close();
  }
});

test('rich_more: one message with the Show more button, expanded in place by file_id', async () => {
  const api = await fakeBotApi();
  try {
    const sender = senderFor(api.apiRoot);
    const preview = '<p>header</p><tg-slideshow><img src="tg://photo?id=m0"/></tg-slideshow><p>first paragraph</p>';
    const fullHtml = '<p>header</p><tg-slideshow><img src="tg://photo?id=m0"/></tg-slideshow><p>first paragraph</p><p>the rest</p>';

    const ids = await sender.send({ kind: 'rich_more', html: preview, fullHtml, media: [{ id: 'm0', file: photo, kind: 'photo' }] }, target);
    assert.equal(ids.length, 1);
    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assert.match(html, /<tg-button-row align="left"><tg-button type="callback_data" data="more:[A-Za-z0-9_-]{8}">Show more<\/tg-button><\/tg-button-row>$/, 'the button closes the preview');

    const token = /data="more:([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? '';
    const payload = morePayload(token);
    assert.ok(payload, 'the token recalls the full body');
    assert.equal(payload?.html, fullHtml);
    assert.deepEqual(payload?.media, [{ id: 'm0', kind: 'photo', fileId: 'fid-m0' }], 'the edit reuses the file_id');

    await sender.expandMore(target, ids[0] ?? 0, payload!);
    const edit = api.last('editMessageText');
    assert.equal(edit?.body.message_id, ids[0]);
    assert.equal(edit?.body.rich_message?.html, fullHtml, 'same message, full body');
    assert.equal(edit?.body.rich_message?.media?.[0]?.media?.media, 'fid-m0', 'the slideshow survives the edit');
  } finally {
    await api.close();
  }
});