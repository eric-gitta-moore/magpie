/** Read the same navigation entry shipped to Magpie's sandboxed frame. */
import fs from 'node:fs/promises';
/** Run the entry against the bridge contract, without a second browser or network. */
import vm from 'node:vm';
/** Assert visibility is taken from the bridge property rather than its theme payload. */
import assert from 'node:assert/strict';
/** Keep the async navigation bounded by the test runner. */
import { test } from 'node:test';

test('a page hidden during bridge startup remains hidden after service navigation', async () => {
  const script = await fs.readFile(new URL('../page/boot.js', import.meta.url), 'utf8');
  const destinations = [];
  const node = { addEventListener() {}, hidden: true, textContent: '' };
  vm.runInNewContext(script, {
    magpie: { ready: Promise.resolve({ dark: false, tokens: {} }), visible: false,
      service: '_magpie/service/', options: { async get() { return { port: 3491 }; } } },
    location: { href: 'http://127.0.0.1:3430/plugin/index.html', replace(value) { destinations.push(value); }, reload() {} },
    URL, setTimeout() {}, document: { getElementById() { return node; } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destinations.length, 1);
  const target = new URL(destinations[0]);
  assert.equal(target.searchParams.get('visible'), 'false');
  assert.equal(target.pathname, '/plugin/_magpie/service/');
});
