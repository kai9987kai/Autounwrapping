'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const MODULES = ['math', 'solvers', 'mesh', 'visibility'];
const C = loadCore({ modules: MODULES });

function concat(...soups) {
  const out = new Float32Array(soups.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const s of soups) { out.set(s, o); o += s.length; }
  return out;
}

test('a sphere is uniformly visible (~0.5 per face)', () => {
  const m = C.buildMesh(F.uvSphere(32, 20));
  const { faceVis, edgeVis, vertVis } = C.computeVisibility(m, { views: 48 });
  let lo = 1, hi = 0, sum = 0;
  for (let f = 0; f < m.faceCount; f++) { lo = Math.min(lo, faceVis[f]); hi = Math.max(hi, faceVis[f]); sum += faceVis[f]; }
  assert.ok(Math.abs(sum / m.faceCount - 0.5) < 0.08, 'mean ' + sum / m.faceCount);
  assert.ok(lo > 0.3 && hi < 0.7, lo + '..' + hi);
  assert.equal(edgeVis.length, m.edgeCount);
  assert.equal(vertVis.length, m.weldCount);
});

test('faces enclosed inside another closed box are never visible', () => {
  const outer = F.cube(2), inner = F.cube(0.5);
  const m = C.buildMesh(concat(outer, inner));
  const { faceVis } = C.computeVisibility(m, { views: 32 });
  for (let f = 0; f < 12; f++) assert.ok(faceVis[f] > 0.3, 'outer ' + faceVis[f]);
  for (let f = 12; f < 24; f++) assert.equal(faceVis[f], 0);
});

test('the inner ring of a torus is less visible than the outer rim; upper domain hides the underside', () => {
  const m = C.buildMesh(F.torus(1, 0.35, 24, 48));
  const { faceVis } = C.computeVisibility(m, { views: 64 });
  let inner = 0, ni = 0, outer = 0, no = 0;
  for (let f = 0; f < m.faceCount; f++) {
    const x = m.faceCentroids[3 * f], y = m.faceCentroids[3 * f + 1], r = Math.hypot(x, y);
    if (r < 0.8) { inner += faceVis[f]; ni++; } else if (r > 1.2) { outer += faceVis[f]; no++; }
  }
  assert.ok(inner / ni < outer / no, inner / ni + ' vs ' + outer / no);
  const s = C.buildMesh(F.uvSphere(24, 16));
  const vis = C.computeVisibility(s, { views: 64, domain: 'upper', up: [0, 1, 0] }).faceVis;
  let top = 0, nt = 0, bot = 0, nb = 0;
  for (let f = 0; f < s.faceCount; f++) { const y = s.faceCentroids[3 * f + 1]; if (y > 0.5) { top += vis[f]; nt++; } else if (y < -0.5) { bot += vis[f]; nb++; } }
  assert.ok(bot / nb < top / nt, 'underside ' + bot / nb + ' top ' + top / nt);
});

test('30k faces with 64 views is reasonably fast; viaSource works', () => {
  const m = C.buildMesh(F.torusKnot(0.8, 0.3, 320, 48));
  const t0 = performance.now();
  C.computeVisibility(m, { views: 64 });
  assert.ok(performance.now() - t0 < 8000);
  const CS = loadCore({ viaSource: true, modules: MODULES });
  assert.equal(CS.computeVisibility(CS.buildMesh(F.cube()), { views: 16 }).faceVis.length, 12);
});
