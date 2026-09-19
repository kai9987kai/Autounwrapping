'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const C = loadCore();

test('mesh preflight detects duplicates, winding defects, collapse and thin faces', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const duplicate = C.buildMesh(new Float32Array([...tri, ...tri])).diagnostics;
  assert.equal(duplicate.duplicateFaces, 1);
  assert.equal(duplicate.inconsistentEdges, 3);
  assert.equal(duplicate.healthy, false);
  assert.equal(C.buildMesh(new Float32Array([0,0,0, 1,0,0, 2,0,0])).diagnostics.degenerateFaces, 1);
  assert.equal(C.buildMesh(new Float32Array([0,0,0, 1,0,0, 0,0.0001,0])).diagnostics.sliverFaces, 1);
  const open = C.buildMesh(new Float32Array(tri)).diagnostics;
  assert.equal(open.healthy, true);
  assert.equal(open.closed, false);
  assert.equal(open.boundaryEdges, 3);
});

test('mesh rejects malformed coordinates and tolerances before topology work', () => {
  assert.throws(() => C.buildMesh([0, 1]), /complete triangles/);
  for (const value of [NaN, Infinity, -Infinity]) {
    const p = new Float32Array(9); p[0] = value;
    assert.throws(() => C.buildMesh(p), /finite/);
  }
  for (const weldTolerance of [0, -1, Infinity, NaN]) assert.throws(() => C.buildMesh(F.cube(), { weldTolerance }), /tolerance/);
  assert.equal(C.buildMesh(F.cube()).diagnostics.healthy, true);
});

test('cube welds to 8 vertices, 18 edges, 12 faces, chi = 2, closed, manifold', () => {
  const m = C.buildMesh(F.cube());
  assert.equal(m.faceCount, 12);
  assert.equal(m.weldCount, 8);
  assert.equal(m.edgeCount, 18);
  assert.equal(m.eulerCharacteristic, 2);
  assert.equal(m.boundaryEdgeCount, 0);
  assert.equal(m.nonManifoldEdgeCount, 0);
  assert.equal(m.componentCount, 1);
  assert.ok(Math.abs(m.surfaceArea - 6) < 1e-6);
  for (let f = 0; f < 12; f++) assert.equal(m.adjStart[f + 1] - m.adjStart[f], 3);
});

test('open grid patch has a boundary of 2*(nx+ny) edges and chi = 1', () => {
  const m = C.buildMesh(F.gridPatch(6, 4));
  assert.equal(m.weldCount, 7 * 5);
  assert.equal(m.boundaryEdgeCount, 2 * (6 + 4));
  assert.equal(m.eulerCharacteristic, 1);
});

test('annulus has chi = 0 and two boundary loops worth of edges', () => {
  const m = C.buildMesh(F.annulusPatch(10, 10, 4));
  assert.equal(m.eulerCharacteristic, 0);
  assert.equal(m.boundaryEdgeCount, 40 + 16);
});

test('sphere is closed with chi = 2; torus and torus knot chi = 0', () => {
  assert.equal(C.buildMesh(F.uvSphere(16, 12)).eulerCharacteristic, 2);
  assert.equal(C.buildMesh(F.torus(1, 0.3, 12, 24)).eulerCharacteristic, 0);
  const tk = C.buildMesh(F.torusKnot());
  assert.equal(tk.eulerCharacteristic, 0);
  assert.equal(tk.boundaryEdgeCount, 0);
  assert.equal(tk.faceCount, 7680);
});

test('non-manifold fan of three faces on one edge is counted', () => {
  const p = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 1, 0, 0, 0, 0, 1,
    0, 0, 0, 1, 0, 0, 0, -1, 0
  ]);
  const m = C.buildMesh(p);
  assert.equal(m.nonManifoldEdgeCount, 1);
  assert.equal(m.edgeCount, 7);
  assert.equal(m.adjStart[1] - m.adjStart[0], 2);
});

test('connectedComponents respects cut edges', () => {
  const m = C.buildMesh(F.gridPatch(4, 1));
  const all = Array.from({ length: m.faceCount }, (_, i) => i);
  assert.equal(C.connectedComponents(m, all).length, 1);
  const cut = new Uint8Array(m.edgeCount);
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeVerts[e * 2] * 3, b = m.edgeVerts[e * 2 + 1] * 3;
    if (Math.abs(m.weldPos[a]) < 1e-9 && Math.abs(m.weldPos[b]) < 1e-9) cut[e] = 1;
  }
  assert.equal(C.connectedComponents(m, all, cut).length, 2);
});

test('findEdge and edgeSegments', () => {
  const m = C.buildMesh(F.cube());
  const e = m.faceEdges[0];
  assert.equal(C.findEdge(m, m.edgeVerts[e * 2], m.edgeVerts[e * 2 + 1]), e);
  const flags = new Uint8Array(m.edgeCount); flags[e] = 1;
  assert.equal(C.edgeSegments(m, flags).length, 6);
});

test('degenerate faces get faceEdges = -1 and do not crash', () => {
  const p = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1]);
  const m = C.buildMesh(p);
  assert.equal(m.faceEdges[0], -1);
  assert.equal(m.faceCount, 1);
});

test('buildMesh on the torus knot is fast', () => {
  const t0 = performance.now();
  C.buildMesh(F.torusKnot(0.8, 0.3, 320, 48)); // 30k faces
  assert.ok(performance.now() - t0 < 4500);
});
