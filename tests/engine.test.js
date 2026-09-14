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
