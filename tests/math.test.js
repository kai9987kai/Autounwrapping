'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const { mulberry32 } = require('./fixtures');

const C = loadCore();

test('svd2 reconstructs J = U diag(s1,s2) V^T with s1 >= |s2| and sign(s2) = sign(det)', () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 3000; i++) {
    const a = rnd() * 4 - 2, b = rnd() * 4 - 2, c = rnd() * 4 - 2, d = rnd() * 4 - 2;
    const s = C.svd2(a, b, c, d);
    const m00 = s.cosU * s.s1 * s.cosV + s.sinU * s.s2 * s.sinV;
    const m01 = s.cosU * s.s1 * s.sinV - s.sinU * s.s2 * s.cosV;
    const m10 = s.sinU * s.s1 * s.cosV - s.cosU * s.s2 * s.sinV;
    const m11 = s.sinU * s.s1 * s.sinV + s.cosU * s.s2 * s.cosV;
    assert.ok(Math.abs(m00 - a) + Math.abs(m01 - b) + Math.abs(m10 - c) + Math.abs(m11 - d) < 1e-9);
    assert.ok(s.s1 >= Math.abs(s.s2) - 1e-12);
    const det = a * d - b * c;
    if (Math.abs(det) > 1e-9) assert.equal(Math.sign(s.s2), Math.sign(det));
  }
});

test('svd2 of a pure reflection has s2 = -1 and polar2 of a rotation returns it', () => {
  const s = C.svd2(1, 0, 0, -1);
  assert.ok(Math.abs(s.s1 - 1) < 1e-12 && Math.abs(s.s2 + 1) < 1e-12);
  const th = 0.7, r = C.polar2(Math.cos(th) * 2, -Math.sin(th) * 2, Math.sin(th) * 2, Math.cos(th) * 2);
  assert.ok(Math.abs(r.cos - Math.cos(th)) < 1e-12 && Math.abs(r.sin - Math.sin(th)) < 1e-12);
});

test('polar2 equals U V^T of the signed SVD', () => {
  const rnd = mulberry32(3);
  for (let i = 0; i < 1000; i++) {
    const a = rnd() * 4 - 2, b = rnd() * 4 - 2, c = rnd() * 4 - 2, d = rnd() * 4 - 2;
    const s = C.svd2(a, b, c, d), r = C.polar2(a, b, c, d);
    // U V^T = rot(phi - theta)
    const cs = s.cosU * s.cosV + s.sinU * s.sinV, sn = s.sinU * s.cosV - s.cosU * s.sinV;
    assert.ok(Math.abs(cs - r.cos) < 1e-9 && Math.abs(sn - r.sin) < 1e-9);
  }
});

test('MinHeap pops in ascending key order', () => {
  const h = new C.MinHeap();
  const rnd = mulberry32(11);
  const keys = [];
  for (let i = 0; i < 500; i++) { const k = rnd(); keys.push(k); h.push(k, i); }
  keys.sort((a, b) => a - b);
  for (let i = 0; i < 500; i++) assert.equal(h.pop().key, keys[i]);
  assert.equal(h.pop(), undefined);
});

test('UnionFind merges and counts components', () => {
  const uf = new C.UnionFind(6);
  uf.union(0, 1); uf.union(1, 2); uf.union(4, 5);
  assert.equal(uf.count, 3);
  assert.equal(uf.find(0), uf.find(2));
  assert.notEqual(uf.find(0), uf.find(3));
});

test('triangle helpers', () => {
  assert.ok(Math.abs(C.triArea3(0, 0, 0, 1, 0, 0, 0, 1, 0) - 0.5) < 1e-12);
  const n = new Float64Array(3);
  C.triNormal3(0, 0, 0, 1, 0, 0, 0, 1, 0, n, 0);
  assert.deepEqual(Array.from(n), [0, 0, 1]);
  const ang = C.triAngles2(0, 0, 1, 0, 0, 1);
  assert.ok(Math.abs(ang[0] - Math.PI / 2) < 1e-12);
});
