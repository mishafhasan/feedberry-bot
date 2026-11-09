import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCookie, setCookies } from '../../cobalt-engine/src/cookie-store.js';

test('setCookies seeds the pool in memory and ignores what it cannot use', () => {
  const pool = setCookies({ twitter: ['auth_token=abc', 7 as unknown as string], bogus: ['x'], instagram: 'sessionid=1' as unknown as string[] });
  assert.deepEqual(pool.twitter, ['auth_token=abc'], 'only cookie strings are kept');
  assert.equal('bogus' in pool, false, 'an unknown service is ignored');
  assert.equal('instagram' in pool, false, 'a non-array entry is ignored');
  assert.equal(getCookie('twitter')?.toString(), 'auth_token=abc');
});
