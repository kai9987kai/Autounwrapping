'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');

const MODULES = ['math', 'solvers', 'mesh', 'segmentation'];
const C = loadCore({ modules: MODULES });

/* Partition invariants: every face in exactly one chart, faceChart agrees with
 * chartFaces, and each chart is connected through non-cut edges. */
function checkPartition(m, res, cut) {
  const nF = m.faceCount;
  assert.equal(res.faceChart.length, nF);
  const seen = new Uint8Array(nF);
  const queue = new Int32Array(nF);
  const visit = new Int32Array(nF).fill(-1);
  let total = 0;
  res.chartFaces.forEach((faces, c) => {
    assert.ok(faces.length > 0, 'empty chart ' + c);
    total += faces.length;
    for (const f of faces) {
      if (res.faceChart[f] !== c || seen[f]) assert.fail('face ' + f + ' mis-assigned (chart ' + c + ')');
      seen[f] = 1;
    }
    let head = 0, tail = 0;
    queue[tail++] = faces[0]; visit[faces[0]] = c;
    while (head < tail) {
      const f = queue[head++];
      for (let p = m.adjStart[f]; p < m.adjStart[f + 1]; p++) {
        const g = m.adjFaces[p];
        if (visit[g] === c || res.faceChart[g] !== c) continue;
        if (cut && cut[m.adjEdges[p]]) continue;
        visit[g] = c; queue[tail++] = g;
      }
    }
    assert.equal(tail, faces.length, 'chart ' + c + ' is not connected');
  });
  assert.equal(total, nF);
}

function edgesWhere(m, pred) {
  const flags = new Uint8Array(m.edgeCount);
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeVerts[e * 2] * 3, b = m.edgeVerts[e * 2 + 1] * 3;
    if (pred(m.weldPos.subarray(a, a + 3), m.weldPos.subarray(b, b + 3))) flags[e] = 1;
  }
  return flags;
}

/* Interior manifold edges whose two faces lie in different charts. */
function boundaryEdges(m, res) {
  const out = new Uint8Array(m.edgeCount);
  for (let e = 0; e < m.edgeCount; e++) {
    const s = m.edgeFaceStart[e];
    if (m.edgeFaceStart[e + 1] - s !== 2) continue;
    if (res.faceChart[m.edgeFaceList[s]] !== res.faceChart[m.edgeFaceList[s + 1]]) out[e] = 1;
  }
  return out;
}

test('cube -> 6 charts with segmentByAxis and with segmentCharts (angle 50)', () => {
  const m = C.buildMesh(F.cube());
  for (const res of [C.segmentByAxis(m), C.segmentCharts(m, { angleDeg: 50 })]) {
    checkPartition(m, res);
    assert.equal(res.chartFaces.length, 6);
    for (const faces of res.chartFaces) {
      assert.equal(faces.length, 2);
      const [a, b] = faces;
      const d = m.faceNormals[3 * a] * m.faceNormals[3 * b] + m.faceNormals[3 * a + 1] * m.faceNormals[3 * b + 1] + m.faceNormals[3 * a + 2] * m.faceNormals[3 * b + 2];
      assert.ok(d > 0.999);
    }
  }
});

test('sphere: charts connected, every face assigned, reasonable deviation', () => {
  const m = C.buildMesh(F.uvSphere(32, 24));
  const res = C.segmentCharts(m, {});
  checkPartition(m, res);
  assert.ok(res.chartFaces.length >= 6 && res.chartFaces.length <= 40, 'chart count ' + res.chartFaces.length);
  for (const faces of res.chartFaces) {
    if (faces.length < 3) continue;
    let nx = 0, ny = 0, nz = 0;
    for (const f of faces) { nx += m.faceAreas[f] * m.faceNormals[3 * f]; ny += m.faceAreas[f] * m.faceNormals[3 * f + 1]; nz += m.faceAreas[f] * m.faceNormals[3 * f + 2]; }
    const l = Math.hypot(nx, ny, nz);
    for (const f of faces) {
      const d = (m.faceNormals[3 * f] * nx + m.faceNormals[3 * f + 1] * ny + m.faceNormals[3 * f + 2] * nz) / l;
      assert.ok(d > Math.cos(75 * Math.PI / 180), 'face deviates too much from its chart');
    }
  }
});

test('sphere: charts never cross a manual cut ring (segmentCharts, byAxis, whole)', () => {
  const m = C.buildMesh(F.uvSphere(32, 24));
  const cut = edgesWhere(m, (a, b) => Math.abs(a[1]) < 1e-6 && Math.abs(b[1]) < 1e-6);
  assert.equal(cut.reduce((s, v) => s + v, 0), 32);
  const whole = C.segmentWhole(m, cut);
  checkPartition(m, whole, cut);
  assert.equal(whole.chartFaces.length, 2);
  assert.equal(C.segmentWhole(m).chartFaces.length, 1);
  for (const res of [C.segmentCharts(m, { angleDeg: 88, maxFaces: 0 }, cut), C.segmentCharts(m, {}, cut), C.segmentByAxis(m, cut)]) {
    checkPartition(m, res, cut);
    for (const faces of res.chartFaces) {
      const sign = Math.sign(m.faceCentroids[3 * faces[0] + 1]);
      for (const f of faces) assert.equal(Math.sign(m.faceCentroids[3 * f + 1]), sign, 'chart crosses the cut ring');
    }
  }
});

test('Lloyd rounds do not increase the chart count on the sphere; deterministic', () => {
  const m = C.buildMesh(F.uvSphere(32, 24));
  const r0 = C.segmentCharts(m, { lloydIterations: 0 });
  const r3 = C.segmentCharts(m, { lloydIterations: 3 });
  checkPartition(m, r0);
  checkPartition(m, r3);
  assert.ok(r3.chartFaces.length <= r0.chartFaces.length);
  const again = C.segmentCharts(m, { lloydIterations: 3 });
  assert.deepEqual(Array.from(again.faceChart), Array.from(r3.faceChart));
});

test('maxFaces is respected', () => {
  const m = C.buildMesh(F.uvSphere(32, 24));
  const res = C.segmentCharts(m, { maxFaces: 40 });
  checkPartition(m, res);
  for (const faces of res.chartFaces) assert.ok(faces.length <= 40, 'chart of ' + faces.length + ' faces');
  const m2 = C.buildMesh(F.gridPatch(12, 12));
  const r2 = C.segmentCharts(m2, { maxFaces: 50 });
  checkPartition(m2, r2);
  assert.ok(r2.chartFaces.length >= 6);
  for (const faces of r2.chartFaces) assert.ok(faces.length <= 50);
});

test('hemisphere with angle 88 gives few charts; flat grid gives one', () => {
  const m = C.buildMesh(F.hemisphere(24, 8));
  const res = C.segmentCharts(m, { angleDeg: 88 });
  checkPartition(m, res);
  assert.ok(res.chartFaces.length <= 3, 'charts: ' + res.chartFaces.length);
  const g = C.buildMesh(F.gridPatch(10, 10));
  assert.equal(C.segmentCharts(g, {}).chartFaces.length, 1);
});

test('degenerate faces are assigned (collapsed corner, collinear, isolated point)', () => {
  const grid = F.gridPatch(4, 4);
  const p0 = [grid[0], grid[1], grid[2]], p1 = [grid[3], grid[4], grid[5]]; // first face, corners 0 and 1 share a grid edge
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
  const extra = [
    ...p0, ...p0, ...p1,                    // collapsed corner on a grid edge
    ...p0, ...mid, ...p1,                   // zero-area collinear face on the same edge
    0.05, 0.07, 0, 0.05, 0.07, 0, 0.05, 0.07, 0 // fully collapsed, no edges
  ];
  const pos = new Float32Array(grid.length + extra.length);
  pos.set(grid); pos.set(extra, grid.length);
  const m = C.buildMesh(pos);
  const nGrid = grid.length / 9;
  for (const res of [C.segmentCharts(m, {}), C.segmentCharts(m, { mergeSmallCharts: false, lloydIterations: 0 }), C.segmentByAxis(m), C.segmentWhole(m)]) {
    checkPartition(m, res);
    assert.equal(res.faceChart[nGrid], res.faceChart[0], 'collapsed-corner face joins the grid chart');
    assert.equal(res.faceChart[nGrid + 1], res.faceChart[0], 'collinear face joins the grid chart');
    assert.equal(res.chartFaces[res.faceChart[nGrid + 2]].length, 1, 'isolated point face is its own chart');
    assert.equal(res.chartFaces.length, 2);
  }
});

test('edgeSeamCost moves where the chart boundary lands', () => {
  const m = C.buildMesh(F.gridPatch(8, 4));
  assert.equal(C.segmentCharts(m, {}).chartFaces.length, 1);
  for (const x0 of [-0.25, 0.25]) {
    const line = edgesWhere(m, (a, b) => Math.abs(a[0] - x0) < 1e-6 && Math.abs(b[0] - x0) < 1e-6);
    const cost = new Float32Array(m.edgeCount);
    for (let e = 0; e < m.edgeCount; e++) if (line[e]) cost[e] = 10;
    const res = C.segmentCharts(m, { edgeSeamCost: cost });
    checkPartition(m, res);
    assert.equal(res.chartFaces.length, 2);
    assert.deepEqual(Array.from(boundaryEdges(m, res)), Array.from(line).map((v, e) => (m.edgeFaceStart[e + 1] - m.edgeFaceStart[e] === 2 ? v : 0)));
  }
  assert.throws(() => C.segmentCharts(m, { edgeSeamCost: new Float32Array(3) }), RangeError);
});

test('sharp weight splits at a crease that the defaults would cross', () => {
  const t = Math.tan(70 * Math.PI / 180);
  const m = C.buildMesh(F.gridPatch(8, 4, (x) => (x > 1e-9 ? x * t : 0)));
  const base = { angleDeg: 89, weights: { normalSeam: 0 } };
  assert.equal(C.segmentCharts(m, base).chartFaces.length, 1);
  const res = C.segmentCharts(m, { angleDeg: 89, weights: { normalSeam: 0, sharp: 10 } });
  checkPartition(m, res);
  assert.equal(res.chartFaces.length, 2);
  for (const faces of res.chartFaces) {
    const side = m.faceCentroids[3 * faces[0]] > 0;
    for (const f of faces) assert.equal(m.faceCentroids[3 * f] > 0, side);
  }
});

test('segmentByAxis and segmentWhole respect cuts; empty mesh; progress and cancel', () => {
  const m = C.buildMesh(F.gridPatch(4, 4));
  assert.equal(C.segmentByAxis(m).chartFaces.length, 1);
  const cut = edgesWhere(m, (a, b) => Math.abs(a[0]) < 1e-6 && Math.abs(b[0]) < 1e-6);
  const r = C.segmentByAxis(m, cut);
  checkPartition(m, r, cut);
  assert.equal(r.chartFaces.length, 2);
  assert.equal(C.segmentWhole(m, cut).chartFaces.length, 2);
  const rc = C.segmentCharts(m, {}, cut);
  checkPartition(m, rc, cut);
  assert.equal(rc.chartFaces.length, 2);

  const empty = C.buildMesh(new Float32Array(0));
  assert.equal(C.segmentCharts(empty, {}).faceChart.length, 0);
  assert.equal(C.segmentByAxis(empty).chartFaces.length, 0);

  const calls = [];
  C.segmentCharts(m, {}, null, (stage, done, total) => calls.push([stage, done, total]));
  assert.ok(calls.length >= 2);
  assert.equal(calls[calls.length - 1][1], calls[calls.length - 1][2]);
  assert.deepEqual({ ...C.segmentCharts(m, { shouldCancel: () => true }) }, { cancelled: true });
});

test('viaSource round-trip gives identical segmentation', () => {
  const C2 = loadCore({ viaSource: true, modules: MODULES });
  const pos = F.torus(1, 0.35, 16, 32);
  const a = C.segmentCharts(C.buildMesh(pos), {});
  const b = C2.segmentCharts(C2.buildMesh(pos), {});
  assert.deepEqual(Array.from(b.faceChart), Array.from(a.faceChart));
  assert.equal(b.chartFaces.length, a.chartFaces.length);
});

test('torus knot (30k faces) segments quickly', () => {
  const m = C.buildMesh(F.torusKnot(0.8, 0.3, 320, 48));
  assert.equal(m.faceCount, 30720);
  const t0 = performance.now();
  const res = C.segmentCharts(m, {});
  const dt = performance.now() - t0;
  checkPartition(m, res);
  for (const faces of res.chartFaces) assert.ok(faces.length <= 6000);
  assert.ok(dt < 2500, 'took ' + dt.toFixed(0) + ' ms');
});

test('~100k faces with 3 Lloyd rounds', () => {
  const m = C.buildMesh(F.torusKnot(0.8, 0.3, 1000, 50));
  assert.equal(m.faceCount, 100000);
  const t0 = performance.now();
  const res = C.segmentCharts(m, { lloydIterations: 3 });
  const dt = performance.now() - t0;
  checkPartition(m, res);
  assert.ok(dt < 5000, 'took ' + dt.toFixed(0) + ' ms');
});
