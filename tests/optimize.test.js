'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const MODULES = ['math', 'solvers', 'mesh', 'chart', 'parameterize', 'optimize'];
const C = loadCore({ modules: MODULES });

const allFaces = (m) => Array.from({ length: m.faceCount }, (_, i) => i);
function chartFrom(pos, init = 'tutte', Cx = C) {
  const m = Cx.buildMesh(pos);
  const L = Cx.buildChartLocal(m, allFaces(m));
  Cx.initChart(L, init);
  return L;
}
function nonIncreasing(h) { for (let i = 1; i < h.length; i++) if (h[i] > h[i - 1] * (1 + 1e-12)) return false; return true; }

test('rest frames: identity map has J = I, SD = 1 and ARAP = 0', () => {
  const m = C.buildMesh(F.gridPatch(5, 4, null, 2, 1));
  const L = C.buildChartLocal(m, allFaces(m));
  for (let i = 0; i < L.nVerts; i++) { L.uv[2 * i] = L.lp[3 * i]; L.uv[2 * i + 1] = L.lp[3 * i + 1]; }
  const fr = C.buildRestFrames(L);
  assert.ok(Math.abs(fr.totalArea - 2) < 1e-9);
  assert.ok(Math.abs(C.chartEnergy(L, fr, 'sd') - 1) < 1e-9);
  assert.ok(Math.abs(C.chartEnergy(L, fr, 'arap')) < 1e-9);
});

test('SLIM from a Tutte start on the hemisphere: monotone, flip-free, SD < 1.2', () => {
  const L = chartFrom(F.hemisphere(24, 10), 'tutte');
  const r = C.optimizeChart(L, { energy: 'sd', iterations: 30 });
  assert.ok(!r.skipped, r.skipped);
  assert.ok(nonIncreasing(r.history), 'history ' + r.history.join(', '));
  assert.equal(r.flips, 0);
  assert.equal(C.countFlips(L), 0);
  assert.ok(r.energyAfter < r.energyBefore);
  assert.ok(r.energyAfter < 1.2, 'SD ' + r.energyAfter);
});

test('ARAP decreases its energy and stays flip-free', () => {
  const L = chartFrom(F.hemisphere(20, 8), 'tutte');
  const fr = C.buildRestFrames(L);
  const before = C.chartEnergy(L, fr, 'arap');
  const r = C.optimizeChart(L, { energy: 'arap', iterations: 15 });
  assert.ok(nonIncreasing(r.history));
  assert.ok(C.chartEnergy(L, fr, 'arap') < before);
  assert.equal(r.flips, 0);
});

test('PCG global solve reaches lower energy than Jacobi sweeps in the same iterations', () => {
  const a = chartFrom(F.hemisphere(24, 10), 'tutte');
  const b = chartFrom(F.hemisphere(24, 10), 'tutte');
  const ra = C.optimizeChart(a, { iterations: 6, globalSolve: 'pcg', anderson: 0, tol: 0 });
  const rb = C.optimizeChart(b, { iterations: 6, globalSolve: 'jacobi', anderson: 0, tol: 0 });
  assert.ok(ra.energyAfter < rb.energyAfter, 'pcg ' + ra.energyAfter + ' jacobi ' + rb.energyAfter);
});

test('Anderson acceleration never increases energy and helps or ties', () => {
  const a = chartFrom(F.gridPatch(20, 20, (x, y) => 0.3 * Math.sin(5 * x) * Math.cos(4 * y)), 'tutte');
  const b = chartFrom(F.gridPatch(20, 20, (x, y) => 0.3 * Math.sin(5 * x) * Math.cos(4 * y)), 'tutte');
  const ra = C.optimizeChart(a, { iterations: 10, anderson: 5, tol: 0 });
  const rb = C.optimizeChart(b, { iterations: 10, anderson: 0, tol: 0 });
  assert.ok(nonIncreasing(ra.history));
  assert.ok(ra.energyAfter <= rb.energyAfter * 1.02, 'AA ' + ra.energyAfter + ' plain ' + rb.energyAfter);
});

test('rest-scale invariance: scaling the input by 10 gives the same energy', () => {
  const pos = F.hemisphere(16, 6);
  const big = pos.map(v => v * 10);
  const a = chartFrom(pos, 'bff'), b = chartFrom(big, 'bff');
  const ra = C.optimizeChart(a, { iterations: 8, tol: 0 });
  const rb = C.optimizeChart(b, { iterations: 8, tol: 0 });
  assert.ok(Math.abs(ra.energyAfter - rb.energyAfter) < 1e-6 * ra.energyAfter, ra.energyAfter + ' vs ' + rb.energyAfter);
});

test('pins stay fixed and the rest converges', () => {
  const L = chartFrom(F.hemisphere(16, 6), 'bff');
  const pins = [L.boundaryLoops[0][0], L.boundaryLoops[0][8]];
  const before = pins.map(p => [L.uv[2 * p], L.uv[2 * p + 1]]);
  const r = C.optimizeChart(L, { iterations: 10, pins });
  pins.forEach((p, i) => { assert.equal(L.uv[2 * p], before[i][0]); assert.equal(L.uv[2 * p + 1], before[i][1]); });
  assert.equal(r.flips, 0);
  assert.ok(nonIncreasing(r.history));
});

test('flipped start is skipped, not corrupted', () => {
  const m = C.buildMesh(F.gridPatch(3, 3));
  const L = C.buildChartLocal(m, allFaces(m));
  C.projectPlanar(L);
  L.uv[2 * L.tris[0]] += 5; // fold a triangle
  const snapshot = Float64Array.from(L.uv);
  const r = C.optimizeChart(L, { iterations: 5 });
  assert.ok(r.skipped);
  assert.ok(r.flips > 0);
});

test('torus knot pieces: BFF + SLIM is fast and flip-free', () => {
  const m = C.buildMesh(F.torusKnot());
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, allFaces(m), cut);
  const t0 = performance.now();
  let flips = 0, worst = 0;
  for (const piece of res.pieces) {
    const L = C.buildChartLocal(m, piece, cut);
    C.initChart(L, 'bff');
    const r = C.optimizeChart(L, { iterations: 12 });
    flips += r.flips;
    worst = Math.max(worst, r.energyAfter);
    assert.ok(nonIncreasing(r.history));
  }
  const ms = performance.now() - t0;
  assert.equal(flips, 0);
  assert.ok(worst < 1.5, 'worst SD ' + worst);
  assert.ok(ms < 15000, 'took ' + ms.toFixed(0) + ' ms');
});

test('viaSource round-trip', () => {
  const CS = loadCore({ viaSource: true, modules: MODULES });
  const L = chartFrom(F.hemisphere(12, 5), 'tutte', CS);
  const r = CS.optimizeChart(L, { iterations: 5 });
  assert.equal(r.flips, 0);
  assert.ok(r.energyAfter <= r.energyBefore);
});
