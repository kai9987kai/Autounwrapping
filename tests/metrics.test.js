'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const MODULES = ['math', 'solvers', 'mesh', 'metrics', 'projections'];
const C = loadCore({ modules: MODULES });

/* uv (6F) from a function of each corner's 3D position */
function uvFrom(m, fn) {
  const uv = new Float32Array(m.faceCount * 6);
  for (let c = 0; c < m.faceCount * 3; c++) {
    const [u, v] = fn(m.positions[3 * c], m.positions[3 * c + 1], m.positions[3 * c + 2], c);
    uv[2 * c] = u; uv[2 * c + 1] = v;
  }
  return uv;
}
function concat(...soups) {
  const out = new Float32Array(soups.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const s of soups) { out.set(s, o); o += s.length; }
  return out;
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ' got ' + a);

test('isometric map: L2 = Linf = SD = 1, no angle/area error, valid, boundary is not a seam', () => {
  const m = C.buildMesh(F.gridPatch(6, 6));
  const uv = uvFrom(m, (x, y) => [0.3 * x + 0.5, 0.3 * y + 0.5]);
  const r = C.computeMetrics(m, uv, new Int32Array(m.faceCount), null);
  near(r.stretchL2, 1, 1e-5, 'L2'); near(r.stretchLinf, 1, 1e-4, 'Linf'); near(r.sdMean, 1, 1e-5, 'SD');
  near(r.angleMeanDeg, 0, 1e-3, 'angle'); near(r.areaLog2Mean, 0, 1e-4, 'area');
  assert.equal(r.flipped, 0); assert.equal(r.degenerate, 0); assert.equal(r.outOfRange, 0);
  assert.equal(r.bijectivity.valid, true);
  assert.equal(r.seamEdgeCount, 0);
  near(r.boundaryLength3D, 4, 1e-6, 'boundary');
  near(r.coverageExact, 0.09, 1e-5, 'coverage');
  assert.ok(r.score.components.sd.score >= 0.9 && r.score.components.angle.score >= 0.9);
  near(r.efficiency.stretchEff, 1, 1e-5, 'stretchEff');
});

test('uniform anisotropic stretch gives the hand-derived L2, Linf and SD', () => {
  const m = C.buildMesh(F.gridPatch(4, 4));
  const uv = uvFrom(m, (x, y) => [0.4 * x + 0.5, 0.2 * y + 0.5]);
  const r = C.computeMetrics(m, uv, new Int32Array(m.faceCount), null);
  // global-scale singular values: sqrt(2), 1/sqrt(2)
  near(r.sdMean, 1.25, 1e-5, 'SD');
  near(r.stretchL2, Math.sqrt(1.25), 1e-5, 'L2');
  near(r.stretchLinf, Math.SQRT2, 1e-4, 'Linf');
  near(r.efficiency.stretchEff, 1 / 1.25, 1e-5, 'Es');
  near(r.areaLog2Mean, 0, 1e-4, 'uniform scaling has no relative area error');
});

test('a flipped face is flagged, excluded from SD stats and gates the score', () => {
  const m = C.buildMesh(F.gridPatch(4, 4));
  const uv = uvFrom(m, (x, y) => [0.3 * x + 0.5, 0.3 * y + 0.5]);
  // swap corners 1 and 2 of face 5 in UV
  for (let d = 0; d < 2; d++) { const t = uv[2 * (15 + 1) + d]; uv[2 * (15 + 1) + d] = uv[2 * (15 + 2) + d]; uv[2 * (15 + 2) + d] = t; }
  const r = C.computeMetrics(m, uv, new Int32Array(m.faceCount), null);
  assert.equal(r.flipped, 1);
  assert.equal(r.faceFlag[5], 1);
  assert.equal(r.faceSD[5], Infinity);
  assert.ok(Number.isFinite(r.sdMean));
  assert.equal(r.bijectivity.valid, false);
  assert.ok(r.score.score <= 49 && r.score.gate);
});

test('overlapping charts, self-intersecting chart and a contained chart are detected exactly', () => {
  const a = F.gridPatch(2, 2), b = F.gridPatch(2, 2).map((v, i) => i % 3 === 2 ? v + 2 : v);
  const m = C.buildMesh(concat(a, b));
  const half = m.faceCount / 2;
  const chart = new Int32Array(m.faceCount);
  for (let f = half; f < m.faceCount; f++) chart[f] = 1;
  // overlap: chart 1 shifted by 0.1
  const uvO = uvFrom(m, (x, y, z, c) => (c / 3 | 0) < half ? [0.4 * x + 0.5, 0.4 * y + 0.5] : [0.4 * x + 0.6, 0.4 * y + 0.55]);
  const ro = C.computeMetrics(m, uvO, chart, null);
  assert.deepEqual(ro.bijectivity.overlappingPairs.map(p => Array.from(p)), [[0, 1]]);
  assert.ok(ro.overlapTexels > 0);
  assert.equal(ro.bijectivity.valid, false);
  // same layout but both halves labelled as one chart -> self intersection
  const rs = C.computeMetrics(m, uvO, new Int32Array(m.faceCount), null);
  assert.deepEqual(Array.from(rs.bijectivity.selfIntersectingCharts), [0]);
  // containment: chart 1 scaled down inside chart 0, no boundary crossing
  const uvC = uvFrom(m, (x, y, z, c) => (c / 3 | 0) < half ? [0.8 * x + 0.5, 0.8 * y + 0.5] : [0.1 * x + 0.5, 0.1 * y + 0.5]);
  const rc = C.computeMetrics(m, uvC, chart, null);
  assert.deepEqual(Array.from(rc.bijectivity.containedCharts), [1]);
  assert.equal(rc.bijectivity.valid, false);
  // separated: valid
  const uvS = uvFrom(m, (x, y, z, c) => (c / 3 | 0) < half ? [0.2 * x + 0.25, 0.2 * y + 0.5] : [0.2 * x + 0.75, 0.2 * y + 0.5]);
  const rv = C.computeMetrics(m, uvS, chart, null);
  assert.equal(rv.bijectivity.valid, true);
  assert.equal(rv.overlapTexels, 0);
});

test('seams come from chart ids, cut flags and UV discontinuities; islandsFromUV finds them', () => {
  const m = C.buildMesh(F.gridPatch(6, 6));
  const chart = new Int32Array(m.faceCount);
  for (let f = 0; f < m.faceCount; f++) {
    const cx = (m.positions[9 * f] + m.positions[9 * f + 3] + m.positions[9 * f + 6]) / 3;
    chart[f] = cx < 0 ? 0 : 1;
  }
  const uvSame = uvFrom(m, (x, y) => [0.3 * x + 0.5, 0.3 * y + 0.5]);
  const r1 = C.computeMetrics(m, uvSame, chart, null);
  assert.equal(r1.seamEdgeCount, 6);
  near(r1.seamLength3D, 1, 1e-6, 'seam length');
  assert.equal(r1.seamSegments.length, 36);
  // one chart id but the right half's UVs are offset -> discontinuity seam, and 2 islands
  const faceOf = (c) => (c / 3) | 0;
  const uvSplit = uvFrom(m, (x, y, z, c) => chart[faceOf(c)] ? [0.3 * x + 0.55, 0.3 * y + 0.5] : [0.3 * x + 0.45, 0.3 * y + 0.5]);
  const isl = C.islandsFromUV(m, uvSplit);
  assert.equal(isl.chartCount, 2);
  const r2 = C.computeMetrics(m, uvSplit, null, null);
  assert.equal(r2.chartCount, 2);
  assert.equal(r2.seamEdgeCount, 6);
  // cut flags alone
  const cut = new Uint8Array(m.edgeCount); cut[m.faceEdges[0]] = 1;
  const edgeIsInterior = m.edgeFaceStart[m.faceEdges[0] + 1] - m.edgeFaceStart[m.faceEdges[0]] === 2;
  const r3 = C.computeMetrics(m, uvSame, new Int32Array(m.faceCount), cut);
  assert.equal(r3.seamEdgeCount, edgeIsInterior ? 1 : 0);
});

test('texel density: CV 0 when equalised, > 0 otherwise; px/unit follows resolution', () => {
  const m = C.buildMesh(concat(F.gridPatch(2, 2), F.gridPatch(2, 2).map((v, i) => i % 3 === 2 ? v + 2 : v)));
  const half = m.faceCount / 2, chart = new Int32Array(m.faceCount);
  for (let f = half; f < m.faceCount; f++) chart[f] = 1;
  const eq = uvFrom(m, (x, y, z, c) => (c / 3 | 0) < half ? [0.2 * x + 0.25, 0.2 * y + 0.5] : [0.2 * x + 0.75, 0.2 * y + 0.5]);
  const r = C.computeMetrics(m, eq, chart, null, { resolution: 2048 });
  near(r.texelDensity.cv, 0, 1e-6, 'cv');
  near(r.texelDensity.pxPerUnit, 0.2 * 2048, 1e-2, 'px/unit');
  const uneq = uvFrom(m, (x, y, z, c) => (c / 3 | 0) < half ? [0.2 * x + 0.25, 0.2 * y + 0.5] : [0.1 * x + 0.75, 0.1 * y + 0.5]);
  assert.ok(C.computeMetrics(m, uneq, chart, null).texelDensity.cv > 0.2);
});

test('blenderStretch weights are in [0,1]; weightToRgb endpoints; mipSafePadding', () => {
  const m = C.buildMesh(F.hemisphere(12, 5));
  const { uv } = C.projectPlanarWhole(m);
  const bs = C.blenderStretch(m, uv);
  for (const w of bs.area) assert.ok(w >= 0 && w <= 1);
  for (const w of bs.angle) assert.ok(w >= 0 && w <= 1);
  assert.deepEqual(Array.from(C.weightToRgb(0)), [0, 0, 1]);
  assert.deepEqual(Array.from(C.weightToRgb(1)), [1, 0, 0]);
  assert.equal(C.mipSafePadding(1024, 4).maxSafeMip, 2);
  assert.equal(C.mipSafePadding(1024, 1).maxSafeMip, 0);
  assert.equal(C.mipSafePadding(1024, 0).maxSafeMip, -1);
});

test('scoring: valid beats invalid, better stretch scores higher, explanations point to fixes', () => {
  const m = C.buildMesh(F.gridPatch(6, 6));
  const good = C.computeMetrics(m, uvFrom(m, (x, y) => [0.9 * x + 0.5, 0.9 * y + 0.5]), new Int32Array(m.faceCount), null);
  const stretched = C.computeMetrics(m, uvFrom(m, (x, y) => [0.9 * x + 0.5, 0.3 * y + 0.5]), new Int32Array(m.faceCount), null);
  assert.ok(good.score.score > stretched.score.score, good.score.score + ' vs ' + stretched.score.score);
  assert.ok(C.compareMetrics(good, stretched) < 0);
  assert.ok(stretched.score.explanations.some(e => e.metric === 'sd'));
  const bad = C.computeMetrics(m, uvFrom(m, (x, y) => [0.9 * x + 0.5, 0.9 * y + 0.5]).map((v, i) => i === 2 ? v + 0.5 : v), new Int32Array(m.faceCount), null);
  assert.ok(C.compareMetrics(stretched, bad) < 0 || bad.bijectivity.valid);
  for (const k of Object.keys(C.PRESETS)) assert.ok(C.qualityScore(good, { preset: k }).score >= 0);
});

test('degenerate faces and empty meshes do not produce NaN summaries', () => {
  const soup = concat(F.gridPatch(2, 2), new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1]));
  const m = C.buildMesh(soup);
  const uv = uvFrom(m, (x, y) => [0.3 * x + 0.5, 0.3 * y + 0.5]);
  const r = C.computeMetrics(m, uv, null, null);
  assert.equal(r.degenerate, 1);
  for (const k of ['stretchL2', 'sdMean', 'angleMeanDeg', 'areaLog2Mean', 'seamLength3D']) assert.ok(Number.isFinite(r[k]), k);
  const e = C.computeMetrics(C.buildMesh(new Float32Array(0)), new Float32Array(0), null, null);
  assert.equal(e.faces, 0);
  assert.ok(Number.isFinite(e.score.score));
});

test('30k-face torus knot metrics are fast', () => {
  const m = C.buildMesh(F.torusKnot(0.8, 0.3, 320, 48));
  const { uv, faceChart } = C.projectCylindrical(m);
  const t0 = performance.now();
  const r = C.computeMetrics(m, uv, faceChart, null);
  const ms = performance.now() - t0;
  assert.equal(r.faces, m.faceCount);
  assert.ok(ms < 12000, 'took ' + ms.toFixed(0) + ' ms');
});

test('viaSource round-trip', () => {
  const CS = loadCore({ viaSource: true, modules: MODULES });
  const m = CS.buildMesh(F.gridPatch(3, 3));
  const uv = uvFrom(m, (x, y) => [0.3 * x + 0.5, 0.3 * y + 0.5]);
  assert.ok(Math.abs(CS.computeMetrics(m, uv, null, null).sdMean - 1) < 1e-5);
});

test('raster coverage counts texel centres inside the layout', () => {
  const m = C.buildMesh(F.gridPatch(4, 4));
  const uv = uvFrom(m, (x, y) => [0.5 * x + 0.5, 0.5 * y + 0.5]);   // [0.25, 0.75]^2
  const r = C.computeMetrics(m, uv, new Int32Array(m.faceCount), null, { rasterRes: 256 });
  near(r.coverageRaster, 0.25, 0.01, 'raster coverage');
  assert.equal(r.overlapTexels, 0);
});

test('invalid coordinates and collapsed UV faces fail closed without NaN summaries', () => {
  const m = C.buildMesh(F.gridPatch(1, 1));
  const goodUV = uvFrom(m, (x, y) => [0.8 * x + 0.5, 0.8 * y + 0.5]);
  const collapsed = new Float32Array(goodUV.length).fill(0.5);
  const badUV = Float32Array.from(goodUV); badUV[0] = NaN;
  const cases = [collapsed, badUV, Float32Array.from(goodUV, v => v + 2)];
  for (const uv of cases) {
    const r = C.computeMetrics(m, uv, null, null);
    assert.equal(r.score.valid, false);
    assert.equal(r.bake.ready, false);
    assert.ok(r.score.score <= 49);
    for (const key of ['coverageExact', 'coverageRaster', 'stretchL2', 'score']) {
      assert.ok(!Number.isNaN(key === 'score' ? r.score.score : r[key]), key);
    }
  }
  const r = C.computeMetrics(m, collapsed, null, null);
  assert.equal(r.uvDegenerate, m.faceCount);
  assert.equal(r.geometryDegenerate, 0);
  assert.equal(r.bijectivity.valid, false);
  assert.ok(r.perChart.every(c => !c.valid));
  const invalid = C.computeMetrics(m, badUV, null, null);
  assert.equal(invalid.nonFinite, 1);
  assert.throws(() => C.computeMetrics(m, goodUV.slice(2), null, null), /six values/);
  assert.throws(() => C.computeMetrics(m, goodUV, new Int32Array([0]), null), /one value/);
  assert.equal(C.logNormalScore(NaN, 0.1, 0.5), 0);
});

test('contained components with one chart label are exact overlaps, even below raster resolution', () => {
  const a = F.gridPatch(1, 1), b = a.map((v, i) => i % 3 === 2 ? v + 2 : v);
  const m = C.buildMesh(concat(a, b));
  const uv = uvFrom(m, (x, y, z) => z < 1 ? [0.8 * x + 0.5, 0.8 * y + 0.5] : [1e-4 * x + 0.6, 1e-4 * y + 0.4]);
  const r = C.computeMetrics(m, uv, new Int32Array(m.faceCount), null, { rasterRes: 16 });
  assert.equal(r.overlapTexels, 0, 'tiny overlap intentionally misses all raster centres');
  assert.equal(r.bijectivity.complete, true);
  assert.equal(r.bijectivity.valid, false);
  assert.deepEqual(Array.from(r.bijectivity.selfIntersectingCharts), [0]);
  assert.equal(r.perChart[0].valid, false);
});

test('duplicate same-winding faces overlap, while shared triangle edges do not', () => {
  const a = F.gridPatch(1, 1);
  const m = C.buildMesh(concat(a, a));
  const uv = uvFrom(m, (x, y) => [0.8 * x + 0.5, 0.8 * y + 0.5]);
  const r = C.computeMetrics(m, uv, new Int32Array(m.faceCount), null);
  assert.equal(r.score.valid, false);
  assert.ok(r.overlapTexels > 0);
  const tinyUV = uvFrom(m, (x, y) => [1e-4 * x + 0.4, 1e-4 * y + 0.6]);
  const tiny = C.computeMetrics(m, tinyUV, new Int32Array(m.faceCount), null, { rasterRes: 16 });
  assert.equal(tiny.overlapTexels, 0);
  assert.equal(tiny.bijectivity.valid, false, 'coincident same-direction boundaries overlap even below raster resolution');
  const patch = C.buildMesh(a);
  const shared = C.computeMetrics(patch, uv.slice(0, 12), new Int32Array([0, 1]), null);
  assert.equal(shared.bijectivity.valid, true);
  assert.equal(shared.overlapTexels, 0);
});

test('local texel density reports variation hidden by a single chart average', () => {
  const m = C.buildMesh(F.gridPatch(2, 1));
  const uv = uvFrom(m, (x, y) => [0.5 + (x <= 0 ? 0.8 : 0.2) * x, 0.5 + 0.4 * y]);
  const r = C.computeMetrics(m, uv, new Int32Array(m.faceCount), null);
  near(r.texelDensity.chartCV, 0, 1e-8, 'chart CV');
  near(r.texelDensity.cv, 1 / 3, 1e-6, 'face area weighted CV');
});

test('bake readiness uses effective padding and cannot certify unknown imported margins', () => {
  const m = C.buildMesh(F.gridPatch(2, 2));
  const uv = uvFrom(m, (x, y) => [0.8 * x + 0.5, 0.8 * y + 0.5]);
  const chart = new Int32Array(m.faceCount);
  const imported = C.computeMetrics(m, uv, chart, null);
  assert.equal(imported.score.valid, true);
  assert.equal(imported.bake.paddingKnown, false);
  assert.equal(imported.bake.paddingTexels, null);
  assert.equal(imported.bake.ready, false);
  const reduced = C.computeMetrics(m, uv, chart, null, { paddingTexels: 16, effectivePaddingTexels: 1.5, paddingSource: 'packer' });
  assert.equal(reduced.bake.maxSafeMip, 0);
  assert.equal(reduced.bake.paddingTexels, 1.5);
  assert.equal(reduced.bake.requestedPaddingTexels, 16);
  assert.equal(reduced.bake.ready, false);
  const packed = C.computeMetrics(m, uv, chart, null, { effectivePaddingTexels: 8, paddingSource: 'packer' });
  assert.equal(packed.bake.ready, true);
  assert.equal(packed.bake.maxSafeMip, 3);
});
