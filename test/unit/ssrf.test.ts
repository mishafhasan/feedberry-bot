import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { assertUrl, isPrivateAddress } from '../../src/platform/ssrf.ts';

test('M2 ssrf: scheme, credentials, port and length rules (§12.2 rule 1)', () => {
  assert.equal(assertUrl('https://example.com/feed').hostname, 'example.com');
  for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com:8080/', `https://example.com/${'a'.repeat(2100)}`]) {
    assert.throws(
      () => assertUrl(bad),
      (err) => err instanceof Coded && err.code === E.LINK_INVALID,
      bad,
    );
  }
});

test('M2 ssrf: private, loopback, link-local, CGNAT and v6 ranges are rejected (§12.2 rule 3)', () => {
  const privateAddresses = ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1'];
  for (const ip of privateAddresses) assert.equal(isPrivateAddress(ip), true, ip);

  const publicAddresses = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111'];
  for (const ip of publicAddresses) assert.equal(isPrivateAddress(ip), false, ip);
});
