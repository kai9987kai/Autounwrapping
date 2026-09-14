'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const MODULES = ['math', 'solvers', 'mesh', 'chart'];
const C = loadCore({ modules: MODULES });

const allFaces = (m) => Array.from({ length: m.faceCount }, (_, i) => i);

function edgesWhere(m, pred) {
  const out = [];
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeVerts[e * 2] * 3, b = m.edgeVerts[e * 2 + 1] * 3, P = m.weldPos;
    if (pred(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2])) out.push(e);
  }
  return out;
}

/* every face exactly once; every piece connected (not across cuts) and a disk */
function checkDiskPieces(Cx, m, faces, res, cut) {
  const seen = new Uint8Array(m.faceCount);
  let total = 0;
  for (const piece of res.pieces) {
    for (const f of piece) { assert.equal(seen[f], 0, 'face in two pieces'); seen[f] = 1; total++; }
    const L = Cx.buildChartLocal(m, piece, cut);
    assert.ok(L.euler.isDisk, 'piece not a disk: ' + JSON.stringify(L.euler));
    assert.equal(Cx.connectedComponents(m, piece, cut).length, 1, 'piece disconnected');
  }
  assert.equal(total, faces.length);
}

test('grid patch: disk, one ordered boundary loop, lp / localWeld / area', () => {
  const m = C.buildMesh(F.gridPatch(8, 8));
  const L = C.buildChartLocal(m, allFaces(m));
  assert.equal(L.faces.length, 128);
  assert.equal(L.nVerts, 81);
  assert.deepEqual({ ...L.euler }, { V: 81, E: 208, F: 128, chi: 1, loops: 1, isDisk: true });
  assert.equal(L.boundaryLoops.length, 1);
  assert.equal(L.boundaryLoops[0].length, 32);
  assert.equal(L.isBoundary.reduce((s, x) => s + x, 0), 32);
  assert.ok(Math.abs(L.area3D - 1) < 1e-6);
  assert.equal(L.uv.length, 2 * L.nVerts);
  assert.ok(L.uv instanceof Float64Array && L.lp instanceof Float64Array && L.tris instanceof Int32Array);
  // tris / lp / localWeld consistent with the mesh
  for (let t = 0; t < L.faces.length; t++) {
    for (let k = 0; k < 3; k++) {
      const c = L.faces[t] * 3 + k, v = L.tris[3 * t + k];
      assert.equal(L.localWeld[v], m.cornerWeld[c]);
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(L.lp[3 * v + a] - m.positions[3 * c + a]) < 1e-6);
    }
  }
  // loop follows CCW winding: signed area of the boundary polygon > 0
  const lv = L.boundaryLoops[0];
  let A = 0;
  for (let i = 0; i < lv.length; i++) {
    const p = lv[i] * 3, q = lv[(i + 1) % lv.length] * 3;
    A += L.lp[p] * L.lp[q + 1] - L.lp[q] * L.lp[p + 1];
    assert.ok(L.isBoundary[lv[i]]);
  }
  assert.ok(Math.abs(A / 2 - 1) < 1e-6);
  assert.deepEqual({ ...C.chartTopology(L) }, { ...L.euler });
});

test('annulus: loops 2, chi 0; cutToDisk adds one 3-edge path and becomes a disk', () => {
  const m = C.buildMesh(F.annulusPatch(10, 10, 4));
  const faces = allFaces(m);
  const L = C.buildChartLocal(m, faces);
  assert.equal(L.nVerts, 112);
  assert.equal(L.euler.chi, 0);
  assert.equal(L.euler.loops, 2);
  assert.equal(L.euler.isDisk, false);
  assert.deepEqual(Array.from(L.boundaryLoops, l => l.length).sort((a, b) => a - b), [16, 40]);
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, faces, cut);
  assert.equal(res.splits, 0);
  assert.equal(res.pieces.length, 1);
  assert.equal(res.cutsAdded, 3);
  assert.equal(cut.reduce((s, x) => s + x, 0), 3);
  checkDiskPieces(C, m, faces, res, cut);
  assert.equal(C.buildChartLocal(m, faces, cut).nVerts, 116);
});

test('open cylinder: annulus topology, cutToDisk cuts one 4-edge seam', () => {
  const m = C.buildMesh(F.cylinderOpen(24, 4));
  const faces = allFaces(m);
  const L = C.buildChartLocal(m, faces);
  assert.equal(L.nVerts, 120);
  assert.equal(L.euler.chi, 0);
  assert.equal(L.euler.loops, 2);
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, faces, cut);
  assert.equal(res.splits, 0);
  assert.equal(res.cutsAdded, 4);
  checkDiskPieces(C, m, faces, res, cut);
  const L2 = C.buildChartLocal(m, faces, cut);
  assert.equal(L2.nVerts, 125);
  assert.equal(L2.boundaryLoops.length, 1);
});

test('closed uvSphere is bisected into disks', () => {
  const m = C.buildMesh(F.uvSphere(24, 16));
  const faces = allFaces(m);
  const L = C.buildChartLocal(m, faces);
  assert.equal(L.euler.chi, 2);
  assert.equal(L.euler.loops, 0);
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, faces, cut);
  assert.ok(res.splits >= 1);
  assert.ok(res.pieces.length >= 2);
  checkDiskPieces(C, m, faces, res, cut);
  // maxSplits = 0 returns the closed chart as-is
  const res0 = C.cutToDisk(m, faces, new Uint8Array(m.edgeCount), { maxSplits: 0 });
  assert.equal(res0.splits, 0);
  assert.equal(res0.pieces.length, 1);
  assert.equal(res0.pieces[0].length, faces.length);
});

test('torus (genus 1) becomes disks', () => {
  const m = C.buildMesh(F.torus(1, 0.35, 12, 24));
  const faces = allFaces(m);
  const L = C.buildChartLocal(m, faces);
  assert.equal(L.euler.chi, 0);
  assert.equal(L.euler.loops, 0);
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, faces, cut);
  assert.ok(res.splits >= 1);
  checkDiskPieces(C, m, faces, res, cut);
});

test('closed cube becomes disks', () => {
  const m = C.buildMesh(F.cube());
  const faces = allFaces(m);
  assert.equal(C.buildChartLocal(m, faces).euler.chi, 2);
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, faces, cut);
  assert.ok(res.splits >= 1);
  checkDiskPieces(C, m, faces, res, cut);
});

test('manual cuts inside a grid split vertices with the expected topology', () => {
  const m = C.buildMesh(F.gridPatch(6, 6));
  const faces = allFaces(m);
  const base = C.buildChartLocal(m, faces);
  assert.deepEqual({ ...base.euler }, { V: 49, E: 120, F: 72, chi: 1, loops: 1, isDisk: true });
  const onRow = (x0, x1) => edgesWhere(m, (ax, ay, az, bx, by) =>
    Math.abs(ay) < 1e-6 && Math.abs(by) < 1e-6 && Math.min(ax, bx) > x0 - 1e-6 && Math.max(ax, bx) < x1 + 1e-6);

  // single interior edge: no vertex fan is broken twice -> nothing splits
  {
    const cut = new Uint8Array(m.edgeCount);
    const es = onRow(-1 / 6, 0); assert.equal(es.length, 1); cut[es[0]] = 1;
    const L = C.buildChartLocal(m, faces, cut);
    assert.equal(L.nVerts, 49);
    assert.ok(L.euler.isDisk);
  }
  // boundary -> interior slit of 3 edges: 3 vertices split, still a disk
  {
    const cut = new Uint8Array(m.edgeCount);
    const es = onRow(-0.5, 0); assert.equal(es.length, 3); for (const e of es) cut[e] = 1;
    const L = C.buildChartLocal(m, faces, cut);
    assert.equal(L.nVerts, 52);
    assert.deepEqual({ ...L.euler }, { V: 52, E: 123, F: 72, chi: 1, loops: 1, isDisk: true });
    assert.equal(L.boundaryLoops[0].length, 24 + 6);
    // split copies keep their welded id
    const counts = new Map();
    for (const w of L.localWeld) counts.set(w, (counts.get(w) || 0) + 1);
    assert.equal([...counts.values()].filter(c => c === 2).length, 3);
  }
  // interior slit of 2 edges: middle vertex splits -> a hole (chi 0, 2 loops)
  {
    const cut = new Uint8Array(m.edgeCount);
    const es = onRow(-1 / 6, 1 / 6); assert.equal(es.length, 2); for (const e of es) cut[e] = 1;
    const L = C.buildChartLocal(m, faces, cut);
    assert.deepEqual({ ...L.euler }, { V: 50, E: 122, F: 72, chi: 0, loops: 2, isDisk: false });
    const res = C.cutToDisk(m, faces, cut);
    assert.equal(res.splits, 0);
    assert.equal(res.pieces.length, 1);
    assert.equal(res.cutsAdded, 2);
    checkDiskPieces(C, m, faces, res, cut);
  }
  // full row: disconnects into two disks
  {
    const cut = new Uint8Array(m.edgeCount);
    const es = onRow(-0.5, 0.5); assert.equal(es.length, 6); for (const e of es) cut[e] = 1;
    const L = C.buildChartLocal(m, faces, cut);
    assert.deepEqual({ ...L.euler }, { V: 56, E: 126, F: 72, chi: 2, loops: 2, isDisk: false });
    const res = C.cutToDisk(m, faces, cut);
    assert.equal(res.pieces.length, 2);
    assert.equal(res.splits, 0);
    assert.equal(res.cutsAdded, 0);
    checkDiskPieces(C, m, faces, res, cut);
  }
});

test('pinch vertices: bowtie splits, rotation walk traces pinched loops', () => {
  // two CCW triangles sharing only the origin
  const m = C.buildMesh(new Float32Array([0, 0, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0, 0, -1, 0.5, 0, -1, -0.5, 0]));
  assert.equal(m.weldCount, 5);
  const L = C.buildChartLocal(m, [0, 1]);
  assert.equal(L.nVerts, 6);
  assert.deepEqual({ ...L.euler }, { V: 6, E: 6, F: 2, chi: 2, loops: 2, isDisk: false });
  assert.deepEqual(Array.from(L.boundaryLoops, l => Array.from(l)), [[0, 1, 2], [3, 4, 5]]);
  assert.equal(L.localWeld[0], L.localWeld[3]);
  const res = C.cutToDisk(m, [0, 1], new Uint8Array(m.edgeCount));
  assert.equal(res.pieces.length, 2);

  // the same bowtie with a genuinely shared local vertex: two loops through 0
  const bow = C.chartBoundaryLoops({ nVerts: 5, tris: new Int32Array([0, 1, 2, 0, 3, 4]) });
  assert.deepEqual({ ...bow.euler }, { V: 5, E: 6, F: 2, chi: 1, loops: 2, isDisk: false });
  assert.deepEqual(Array.from(bow.boundaryLoops, l => Array.from(l)), [[0, 1, 2], [0, 3, 4]]);
  assert.equal(C.chartTopology({ nVerts: 5, tris: new Int32Array([0, 1, 2, 0, 3, 4]) }).loops, 2);

  // quad strip whose two ends touch at one vertex: ONE loop visiting it twice
  const b = (i) => i % 4, u = (i) => 4 + i, tris = [];
  for (let i = 0; i < 4; i++) tris.push(b(i), b(i + 1), u(i + 1), b(i), u(i + 1), u(i));
  const ring = C.chartBoundaryLoops({ nVerts: 9, tris: new Int32Array(tris) });
  assert.deepEqual({ ...ring.euler }, { V: 9, E: 17, F: 8, chi: 0, loops: 1, isDisk: false });
  assert.equal(ring.boundaryLoops[0].length, 10);
  assert.equal(Array.from(ring.boundaryLoops[0]).filter(v => v === 0).length, 2);

  // the same strip as a welded 3D soup: buildChartLocal splits the pinch -> disk
  const verts = [];
  for (let i = 0; i <= 4; i++) { const a = i / 4 * Math.PI * 2; verts.push(Math.cos(a), Math.sin(a), 0); }
  for (let i = 0; i <= 4; i++) { const a = i / 4 * Math.PI * 1.8; verts.push(2 * Math.cos(a), 2 * Math.sin(a), 0); }
  const idx = [];
  for (let i = 0; i < 4; i++) idx.push(i, i + 1, 5 + i + 1, i, 5 + i + 1, 5 + i);
  const ms = C.buildMesh(F.soupFromIndexed(verts, idx));
  assert.equal(ms.weldCount, 9);
  const Ls = C.buildChartLocal(ms, allFaces(ms));
  assert.equal(Ls.nVerts, 10);
  assert.ok(Ls.euler.isDisk);
});

test('non-manifold and inconsistently oriented edges behave like cuts', () => {
  const fan = C.buildMesh(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 1, 0, 0, 0, 0, 1,
    0, 0, 0, 1, 0, 0, 0, -1, 0
  ]));
  const L = C.buildChartLocal(fan, [0, 1, 2]);
  assert.equal(L.nVerts, 9);
  assert.equal(L.euler.loops, 3);
  const cut = new Uint8Array(fan.edgeCount);
  const res = C.cutToDisk(fan, [0, 1, 2], cut);
  assert.equal(res.pieces.length, 3);
  checkDiskPieces(C, fan, [0, 1, 2], res, cut);
  // two faces sharing an edge with the same direction
  const flip = C.buildMesh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 0]));
  const Lf = C.buildChartLocal(flip, [0, 1]);
  assert.equal(Lf.nVerts, 6);
  assert.equal(Lf.euler.loops, 2);
});

test('edgeWeight steers the annulus cut to the cheaper side', () => {
  const m = C.buildMesh(F.annulusPatch(10, 10, 4));
  const faces = allFaces(m);
  for (const side of [1, -1]) {
    const w = new Float32Array(m.edgeCount).fill(4);
    const cheap = edgesWhere(m, (ax, ay, az, bx) => side > 0 ? Math.min(ax, bx) > 0.2 - 1e-6 : Math.max(ax, bx) < -0.2 + 1e-6);
    for (const e of cheap) w[e] = 1;
    const cut = new Uint8Array(m.edgeCount);
    const res = C.cutToDisk(m, faces, cut, { edgeWeight: w });
    assert.equal(res.cutsAdded, 3);
    for (let e = 0; e < m.edgeCount; e++) if (cut[e]) assert.equal(w[e], 1, 'cut edge on the expensive side');
    checkDiskPieces(C, m, faces, res, cut);
  }
});

test('shortestVertexPath and localEdgeToGlobal on a grid', () => {
  const m = C.buildMesh(F.gridPatch(8, 8));
  const L = C.buildChartLocal(m, allFaces(m));
  const find = (x, y) => {
    for (let v = 0; v < L.nVerts; v++) if (Math.abs(L.lp[3 * v] - x) < 1e-6 && Math.abs(L.lp[3 * v + 1] - y) < 1e-6) return v;
    return -1;
  };
  const s = find(-0.5, -0.5), t = find(0.5, 0.5), mid = find(0, 0);
  const path = C.shortestVertexPath(L, [s], new Set([t]));
  assert.equal(path.length, 9);                     // straight along the diagonals
  assert.equal(path[0], s); assert.equal(path[8], t);
  assert.ok(path.includes(mid));
  for (let i = 0; i + 1 < path.length; i++) {
    const e = C.localEdgeToGlobal(m, L, path[i], path[i + 1]);
    assert.ok(e >= 0);
  }
  assert.deepEqual(Array.from(C.shortestVertexPath(L, [s], new Set([s]))), [s]);
  assert.equal(C.shortestVertexPath(L, [s], new Set()), null);
  // local triangle edges map onto faceEdges
  for (let tt = 0; tt < L.faces.length; tt++) {
    for (let k = 0; k < 3; k++) {
      assert.equal(C.localEdgeToGlobal(m, L, L.tris[3 * tt + k], L.tris[3 * tt + (k + 1) % 3]), m.faceEdges[L.faces[tt] * 3 + k]);
    }
  }
  assert.equal(C.localEdgeToGlobal(m, L, s, s), -1);
  assert.equal(C.localEdgeToGlobal(m, L, s, t), -1);
});

test('degenerate faces never crash and are topologically invisible', () => {
  const grid = F.gridPatch(4, 4);
  const q = 0.25;
  const extra = new Float32Array([
    -0.5, -0.5, 0, -0.5, -0.5, 0, -0.5 + q, -0.5, 0,   // sliver on a boundary edge
    0, 0, 0, 0, 0, 0, q, 0, 0,                          // sliver on an interior edge
    q, q, 0, q, q, 0, q, q, 0,                          // point face
    5, 5, 5, 5, 5, 5, 5, 5, 5                           // isolated point face
  ]);
  const soup = new Float32Array(grid.length + extra.length);
  soup.set(grid); soup.set(extra, grid.length);
  const m = C.buildMesh(soup);
  const faces = allFaces(m);
  const L = C.buildChartLocal(m, faces);
  assert.equal(L.faces.length, 36);
  assert.equal(L.euler.F, 32);
  assert.equal(L.euler.V, 25);
  assert.ok(L.euler.isDisk);
  for (const v of L.tris) assert.ok(v >= 0 && v < L.nVerts);
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, faces, cut);
  assert.equal(res.pieces.reduce((s, p) => s + p.length, 0), 36);
  for (const p of res.pieces) assert.ok(C.buildChartLocal(m, p, cut).euler.isDisk);
  // chart made only of degenerate faces
  const only = C.cutToDisk(m, [32, 34, 35], new Uint8Array(m.edgeCount));
  assert.equal(only.pieces.reduce((s, p) => s + p.length, 0), 3);
  assert.equal(C.buildChartLocal(m, [35]).euler.F, 0);
});

test('cutToDisk on the torus knot (7680 faces) is fast and yields disks', () => {
  const m = C.buildMesh(F.torusKnot());
  const faces = allFaces(m);
  const cut = new Uint8Array(m.edgeCount);
  const t0 = performance.now();
  const res = C.cutToDisk(m, faces, cut);
  const ms = performance.now() - t0;
  assert.ok(ms < 9000, 'cutToDisk took ' + ms.toFixed(0) + ' ms');
  assert.ok(res.splits >= 1 && res.splits < 64);
  checkDiskPieces(C, m, faces, res, cut);
});

test('viaSource round-trip build works', () => {
  const CS = loadCore({ viaSource: true, modules: MODULES });
  const m = CS.buildMesh(F.annulusPatch(10, 10, 4));
  const faces = allFaces(m);
  assert.equal(CS.buildChartLocal(m, faces).euler.loops, 2);
  const cut = new Uint8Array(m.edgeCount);
  const res = CS.cutToDisk(m, faces, cut);
  assert.equal(res.cutsAdded, 3);
  checkDiskPieces(CS, m, faces, res, cut);
});
