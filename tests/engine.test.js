'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const C = loadCore();

function unwrapped(pos, opts) {
  const E = new C.UVEngine();
  E.setMesh(pos);
  return { E, r: E.unwrap(opts || {}) };
}
function inUnit(uv) { for (const v of uv) if (!(v >= -1e-6 && v <= 1 + 1e-6)) return false; return true; }

test('full unwrap of sphere and torus knot: valid, flip-free, disks, good coverage and stretch', () => {
  for (const pos of [F.uvSphere(32, 20), F.torusKnot()]) {
    const { r } = unwrapped(pos);
    const m = r.metrics;
    assert.equal(m.flipped, 0);
    assert.equal(m.bijectivity.valid, true, JSON.stringify(m.bijectivity) + ' ' + JSON.stringify(r.notes));
    assert.equal(m.overlapTexels, 0);
    assert.ok(r.charts.every(c => c.isDisk));
    assert.ok(r.packing.chartCoverage > 0.35, 'coverage ' + r.packing.chartCoverage);
    assert.ok(m.stretchL2 < 1.05, 'L2 ' + m.stretchL2);
    assert.ok(inUnit(r.uv));
    assert.equal(r.faceChart.length, m.faces);
    assert.ok(r.faceChart.every(c => c >= 0 && c < r.charts.length));
    assert.ok(m.score.score >= 50, 'score ' + m.score.score);
  }
});

test('box, whole and projection modes work; projections cannot relax', () => {
  const E = new C.UVEngine();
  E.setMesh(F.cube());
  const box = E.unwrap({ mode: 'box' });
  assert.equal(box.metrics.chartCount, 6);
  const whole = E.unwrap({ mode: 'whole' });
  assert.ok(whole.metrics.bijectivity.valid);
  assert.ok(whole.charts.length >= 2, 'closed cube must be split');
  for (const mode of ['spherical', 'cylindrical', 'planar']) {
    const p = E.unwrap({ mode });
    assert.equal(p.projection, true);
    assert.throws(() => E.relax({}), /needs an atlas/);
  }
});

test('relax after pack does not explode (stays near-isometric) and repack changes the layout only', () => {
  const { E, r } = unwrapped(F.torusKnot(0.8, 0.3, 80, 12), { iterations: 2 });
  const relaxed = E.relax({ iterations: 20 });
  assert.ok(relaxed.metrics.stretchL2 < 1.3 && relaxed.metrics.stretchL2 <= r.metrics.stretchL2 + 1e-3, r.metrics.stretchL2 + ' -> ' + relaxed.metrics.stretchL2);
  assert.equal(relaxed.metrics.flipped, 0);
  const repacked = E.repack({ packing: { paddingTexels: 12, resolution: 512 } });
  assert.ok(Math.abs(repacked.metrics.sdMean - relaxed.metrics.sdMean) < 1e-3);
  assert.equal(repacked.metrics.chartCount, relaxed.metrics.chartCount);
  assert.equal(repacked.packing.resolution, 512);
});

test('snapshot / restore round-trip reproduces the UVs', () => {
  const { E, r } = unwrapped(F.uvSphere(20, 12));
  const snap = E.snapshot();
  E.unwrap({ segmentation: { angleDeg: 30 } });
  const back = E.restore(snap);
  assert.deepEqual(Array.from(back.uv), Array.from(r.uv));
  assert.equal(back.metrics.chartCount, r.metrics.chartCount);
  // relax still works on restored charts
  assert.equal(E.relax({ iterations: 3 }).metrics.flipped, 0);
});

test('manual seams split charts; seamsFromAngle marks the cube edges; clearSeams resets', () => {
  const E = new C.UVEngine();
  const info = E.setMesh(F.gridPatch(8, 8));
  assert.equal(info.faceCount, 128);
  const before = E.unwrap({ mode: 'whole' });
  assert.equal(before.metrics.chartCount, 1);
  const m = E.mesh, cut = new Uint8Array(m.edgeCount);
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeVerts[2 * e] * 3, b = m.edgeVerts[2 * e + 1] * 3;
    if (Math.abs(m.weldPos[a]) < 1e-9 && Math.abs(m.weldPos[b]) < 1e-9) cut[e] = 1;
  }
  E.setCut(cut);
  const after = E.unwrap({ mode: 'whole' });
  assert.equal(after.metrics.chartCount, 2);
  assert.ok(after.metrics.seamLength3D >= 1 - 1e-6);
  assert.equal(E.edgeSegments('manual').length, 6 * 8);
  const t = E.toggleSeamEdge(0, 0);
  assert.ok(t.edge >= 0);
  E.clearSeams();
  assert.equal(E.getManualCut().reduce((s, x) => s + x, 0), 0);
  E.setMesh(F.cube());
  assert.equal(E.seamsFromAngle(60), 12);
});

test('imported UVs: analyse and convert their islands into seams', () => {
  const E = new C.UVEngine();
  E.setMesh(F.cube());
  const box = E.unwrap({ mode: 'box' });
  const E2 = new C.UVEngine();
  E2.setMesh(F.cube());
  assert.equal(E2.setSourceUV(box.uv), 6);
  const a = E2.analyzeSource({});
  assert.equal(a.chartCount, 6);
  assert.ok(a.bijectivity.valid);
  const s = E2.seamsFromSourceUV();
  assert.equal(s.added, 12);
  assert.equal(E2.unwrap({ mode: 'whole' }).metrics.chartCount, 6);
});

test('imported cylinder UVs preserve a seam inside one connected island, then repack and relax', () => {
  const E = new C.UVEngine(), segments = 12, rows = 3;
  E.setMesh(F.cylinderOpen(segments, rows));
  const source = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < segments; i++) {
    const a = [1 - i / segments, j / rows], b = [1 - i / segments, (j + 1) / rows];
    const c = [1 - (i + 1) / segments, (j + 1) / rows], d = [1 - (i + 1) / segments, j / rows];
    source.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  assert.equal(E.setSourceUV(source), 1);
  assert.equal(E.seamsFromSourceUV().added, rows, 'an internal slit is a seam even when faces remain one island');
  const adopted = E.adoptSource({ packing: { resolution: 256 } });
  assert.deepEqual(adopted.uv, Float32Array.from(source), 'adopting never moves an imported corner');
  assert.equal(adopted.imported, true);
  assert.equal(adopted.charts.length, 1);
  assert.equal(adopted.charts[0].nVerts, (segments + 1) * (rows + 1));
  assert.equal(adopted.charts[0].isDisk, true);
  assert.equal(adopted.metrics.bake.paddingKnown, false);
  const snap = E.snapshot();
  const packed = E.repack({});
  assert.equal(packed.charts.length, 1);
  assert.equal(packed.metrics.bijectivity.valid, true);
  assert.ok(inUnit(packed.uv));
  assert.equal(packed.metrics.bake.paddingTexels, packed.packing.effectivePadding);
  assert.deepEqual(E.restore(snap).uv, adopted.uv);
  assert.deepEqual(E.snapshot().chartTris, snap.chartTris);
  assert.equal(E.relax({ iterations: 3 }).metrics.flipped, 0);
});

test('source validation is transactional and imported degenerate corners retain distinct UVs', () => {
  const E = new C.UVEngine();
  E.setMesh(new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0]));
  const original = new Float32Array([0, 0, 1, 0, 0.8, 1]);
  E.setSourceUV(original);
  for (const bad of [NaN, Infinity, -Infinity, 1e100]) {
    const values = Array.from(original); values[0] = bad;
    assert.throws(() => E.setSourceUV(values), /finite/);
    assert.deepEqual(E.sourceUV, original);
  }
  const adopted = E.adoptSource();
  assert.equal(adopted.charts[0].nVerts, 3, 'UV splits survive coincident geometric corners');
  assert.deepEqual(adopted.uv, original);
  const snapshot = E.snapshot();
  assert.deepEqual(E.restore(snapshot).uv, original);
  assert.deepEqual(E.snapshot().chartUV, snapshot.chartUV);
});

test('adoption cancellation leaves existing UVs and chart state untouched', () => {
  const { E, r } = unwrapped(F.cube(), { mode: 'box' });
  E.setSourceUV(r.uv);
  const before = E.snapshot();
  assert.equal(E.adoptSource({}, null, () => true).cancelled, true);
  assert.deepEqual(E.snapshot(), before);
});

test('selected chart transforms preserve shape edits in undo and report invalid atlas placement', () => {
  const E = new C.UVEngine();
  E.setMesh(F.gridPatch(1, 1));
  E.setSourceUV([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  E.adoptSource({ packing: { resolution: 128 } });
  const original = E.snapshot();
  const transformed = E.transformChart(0, { rotateDegrees: 90, scale: 0.5, offsetU: 0.1, offsetV: -0.1 });
  assert.ok(Math.abs(transformed.uv[0] - 0.85) < 1e-6);
  assert.ok(Math.abs(transformed.uv[1] - 0.15) < 1e-6);
  assert.equal(transformed.metrics.bijectivity.valid, true);
  assert.equal(transformed.metrics.bake.paddingKnown, false);
  const edited = E.snapshot();
  E.restore(original);
  E.restore(edited);
  assert.deepEqual(E.snapshot().chartUV, edited.chartUV);
  assert.deepEqual(E.snapshot().uv, edited.uv);
  for (const params of [{ scale: 0 }, { scale: -1 }, { rotateDegrees: Infinity }, { offsetU: NaN }, { scale: 1e100 }]) {
    assert.throws(() => E.transformChart(0, params), /finite|positive/);
    assert.deepEqual(E.snapshot(), edited, 'failed transforms are transactional');
  }
  assert.throws(() => E.transformChart(0.1, {}), /valid chart/);
  const outside = E.transformChart(0, { offsetU: 2 });
  assert.equal(outside.metrics.score.valid, false, 'out-of-tile coordinates cannot pass validation');
  assert.equal(E.repack({}).metrics.bijectivity.valid, true);
});

test('chart transforms only move the selected island and detect newly introduced overlap', () => {
  const { E } = unwrapped(F.cube(), { mode: 'box', packing: { resolution: 128 } });
  const before = E.snapshot(), first = E.state.charts[0].rect, second = E.state.charts[1].rect;
  const r = E.transformChart(0, { offsetU: second.x - first.x, offsetV: second.y - first.y });
  assert.equal(r.metrics.bijectivity.valid, false);
  for (let f = 0; f < E.mesh.faceCount; f++) if (r.faceChart[f] !== 0) {
    assert.deepEqual(r.uv.slice(6 * f, 6 * f + 6), before.uv.slice(6 * f, 6 * f + 6));
  }
});

test('snapshots reject changed geometry and malformed data without changing current state', () => {
  const { E } = unwrapped(F.gridPatch(2, 2), { mode: 'whole', packing: { resolution: 128 } });
  const before = E.snapshot();
  const scaled = new C.UVEngine();
  scaled.setMesh(F.gridPatch(2, 2, null, 2, 1));
  assert.throws(() => scaled.restore(before), /different mesh/);
  for (const corrupt of [
    s => { s.uv = null; },
    s => { s.uv[0] = NaN; },
    s => { s.faceChart[0] = -1; },
    s => { s.chartFaces[0][1] = s.chartFaces[0][0]; },
    s => { s.chartUV[0][0] = Infinity; },
    s => { s.chartTris[0][0] = -1; },
    s => { s.opts.packing = null; },
    s => { s.manualCut[0] = 2; }
  ]) {
    const snap = structuredClone(before); corrupt(snap);
    assert.throws(() => E.restore(snap), /Invalid UV snapshot/);
    assert.deepEqual(E.snapshot(), before);
  }
  const legacy = structuredClone(before);
  legacy.meshKey = E._meshKey(true);
  delete legacy.chartTris;
  assert.deepEqual(E.restore(legacy).uv, before.uv, 'legacy topology fingerprints and inferred local topology remain readable');
});

test('optimizeSearch keeps the best trial; cancel returns { cancelled }', () => {
  const E = new C.UVEngine();
  E.setMesh(F.uvSphere(16, 10));
  const { best, trials } = E.optimizeSearch({});
  assert.equal(trials.length, 3);
  const bestScore = Math.max(...trials.filter(t => t.metrics.valid).map(t => t.score));
  assert.ok(best.metrics.score.score >= bestScore - 1e-9 || !best.metrics.score.valid);
  assert.deepEqual({ ...E.unwrap({}, null, () => true) }, { cancelled: true });
});

test('callbacks can be passed without opts (worker calling convention) and progress fires', () => {
  const E = new C.UVEngine();
  E.setMesh(F.uvSphere(12, 8));
  const stages = new Set();
  const r = E.unwrap((stage) => stages.add(stage), () => false);
  assert.ok(r.metrics);
  for (const s of ['segment', 'pack', 'metrics']) assert.ok(stages.has(s), 'missing stage ' + s);
});

test('results own their buffers (transferring them does not break the engine)', () => {
  const { E, r } = unwrapped(F.uvSphere(12, 8));
  structuredClone(r, { transfer: [r.uv.buffer, r.faceChart.buffer, r.cut.buffer] });
  assert.equal(r.uv.length, 0); // detached in this realm
  const again = E.repack({});
  assert.equal(again.uv.length, 6 * E.mesh.faceCount);
});

test('worker loop: dispatches ops, reports progress, transfers typed arrays, reports errors', async () => {
  const msgs = [];
  const scope = { postMessage: (m, transfer) => msgs.push({ m, transfer }) };
  const engine = C.workerMain(C, scope);
  assert.ok(engine);
  assert.equal(msgs[0].m.type, 'ready');
  assert.ok(msgs[0].m.methods.includes('unwrap') && msgs[0].m.methods.includes('setMesh'));
  await scope.onmessage({ data: { id: 1, op: 'setMesh', args: [F.uvSphere(10, 6)] } });
  await scope.onmessage({ data: { id: 2, op: 'unwrap', args: [{}] } });
  const res = msgs.find(x => x.m.id === 2 && x.m.type === 'result');
  assert.ok(res && res.m.result.metrics);
  assert.ok(res.transfer.length >= 3);
  assert.ok(msgs.some(x => x.m.id === 2 && x.m.type === 'progress'));
  await scope.onmessage({ data: { id: 3, op: 'nope', args: [] } });
  assert.equal(msgs[msgs.length - 1].m.type, 'error');
  await scope.onmessage({ data: { id: 4, op: 'relax', args: [{}] } });
  assert.equal(msgs[msgs.length - 1].m.type, 'result');
  const E2 = C.workerMain(C, { postMessage() {} });
  assert.ok(E2);
});

test('viaSource round-trip: the serialised kernel unwraps', () => {
  const CS = loadCore({ viaSource: true });
  const E = new CS.UVEngine();
  E.setMesh(F.cube());
  const r = E.unwrap({});
  assert.ok(r.metrics.bijectivity.valid);
  assert.equal(r.metrics.flipped, 0);
});

test('review fixes: foreign snapshots are rejected, cancel paths return { cancelled }, seams after search', () => {
  const A = new C.UVEngine();
  A.setMesh(F.torus(1, 0.35, 12, 24));
  A.unwrap({});
  const snap = A.snapshot();
  const B = new C.UVEngine();
  B.setMesh(F.gridPatch(24, 12)); // same face count, different mesh
  B.unwrap({ mode: 'whole' });
  assert.throws(() => B.restore(snap), /different mesh/);
  assert.equal(B.unwrap({ mode: 'whole' }).metrics.chartCount, 1, 'engine still usable');
  // relax cancelled on the first check leaves the layout untouched
  const before = Float64Array.from(A.state.charts[0].local.uv);
  assert.deepEqual({ ...A.relax({}, null, () => true) }, { cancelled: true });
  assert.deepEqual(Array.from(A.state.charts[0].local.uv), Array.from(before));
  // cancel arriving during the last chart
  let calls = 0;
  const E = new C.UVEngine();
  E.setMesh(F.uvSphere(12, 8));
  const r = E.unwrap({ mode: 'whole', iterations: 30 }, null, () => ++calls > 40);
  assert.ok(r.cancelled || r.metrics);
  // seams available after optimizeSearch restores the best state
  E.optimizeSearch({});
  assert.ok(E.edgeSegments('seams').length >= 0);
  // internal methods are private to the worker protocol
  assert.ok(!C.publicMethods(E).some(n => /^(requireMesh|packState|finish|result|restoreState)$/.test(n)));
});

test('review fixes: charts that cannot fit are scaled down without stacking', () => {
  const E = new C.UVEngine();
  E.setMesh(F.torusKnot(0.8, 0.3, 60, 8));
  const r = E.unwrap({ segmentation: { angleDeg: 20, maxFaces: 20 }, iterations: 0, optimizer: 'none', packing: { resolution: 64, paddingTexels: 6 } });
  assert.equal(r.metrics.bijectivity.valid, true, 'no stacked charts');
  assert.equal(r.packing.fits, false);
  assert.ok(r.packing.effectivePadding < r.opts.packing.paddingTexels);
  assert.equal(r.metrics.bake.paddingTexels, r.packing.effectivePadding);
  assert.equal(E.metrics().bake.paddingTexels, r.packing.effectivePadding);
  assert.equal(E.restore(E.snapshot()).metrics.bake.paddingTexels, r.packing.effectivePadding);
  assert.ok(r.notes.some(n => /did not fit/.test(n)));
});
