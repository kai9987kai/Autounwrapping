'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');

test('registry builds the kernel and round-trips through source()', () => {
  const C = loadCore();
  assert.equal(C.clamp(5, 0, 1), 1);
  const C2 = loadCore({ viaSource: true });
  assert.equal(C2.clamp(-1, 0, 1), 0);
  assert.equal(JSON.stringify(C2.__modules), JSON.stringify(C.__modules));
});
