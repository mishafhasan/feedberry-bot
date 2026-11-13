/**
 * The engine's descriptor is the only thing cobalt's downloader sees: a merged YouTube result is
 * two URLs, and the size probe must read the total a CDN reports without pulling the file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bytesFrom, downloadInput, type MediaItem } from '../../src/media/media-engine.ts';

const video: MediaItem = { kind: 'video', url: 'https://cdn.test/v.mp4', picker: false };

test('the descriptor carries the audio track, so YouTube lands with sound', () => {
  const merged = downloadInput({ ...video, audio: 'https://cdn.test/a.m4a' });

  assert.deepEqual(merged.urls, ['https://cdn.test/v.mp4', 'https://cdn.test/a.m4a']);
  assert.equal(merged.type, 'video');
  assert.equal(merged.filename, 'media-video.mp4', 'a muxed write needs its container in the name');
});

test('a carousel item still travels through the picker branch', () => {
  const picker = downloadInput({ kind: 'photo', url: 'https://cdn.test/p.jpg', picker: true, audio: 'https://cdn.test/a.m4a' });

  assert.deepEqual(picker.picker, [{ type: 'photo', url: 'https://cdn.test/p.jpg' }], 'a carousel item has no second track');
  assert.equal(picker.urls, undefined);
  assert.equal(picker.filename, 'media-photo.jpg');
});

test('a size probe reads the total of a ranged answer before the plain length', () => {
  assert.equal(bytesFrom(new Headers({ 'content-range': 'bytes 0-0/491858616' })), 491858616);
  assert.equal(bytesFrom(new Headers({ 'content-length': '99' })), 99, 'a plain answer only names its length');
  assert.equal(bytesFrom(new Headers({})), null, 'a host that will not say is null, never zero');
  assert.equal(bytesFrom(new Headers({ 'content-range': 'bytes 0-0/*' })), null);
});
