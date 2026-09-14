'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowser } = require('./load-browser');

const ctx = loadBrowser({ scripts: ['src/ui/help.js'] });
const H = ctx.UVApp.help;

test('help search ranks the most relevant topic first and covers core concepts', () => {
  assert.ok(H.topics().length >= 20);
  assert.equal(H.search('bff')[0].t, 'Boundary First Flattening (BFF)');
  assert.equal(H.search('padding mip')[0].t, 'Packing');
  assert.equal(H.search('keyboard')[0].t, 'Keyboard shortcuts');
  assert.equal(H.search('').length, H.topics().length);
  assert.equal(H.search('zzzz-nothing').length, 0);
  for (const q of ['score', 'seam tool', 'bake', 'lightmap', 'overlap', 'undo']) assert.ok(H.search(q).length > 0, q);
});
