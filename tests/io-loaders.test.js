'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowser } = require('./load-browser');

const ctx = loadBrowser({ three: ['OBJLoader.js', 'STLLoader.js', 'PLYLoader.js', 'GLTFLoader.js', 'GLTFExporter.js', 'BufferGeometryUtils.js'], scripts: ['src/io/loaders.js'] });
const L = ctx.UVApp.loaders, THREE = ctx.THREE;

const CUBE_OBJ = `o cube
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
usemtl red
f 5/1 6/2 7/3 8/4
f 2/1 1/2 4/3 3/4
f 6/1 2/2 3/3 7/4
usemtl blue
f 1/1 5/2 8/3 4/4
f 8/1 7/2 3/3 4/4
f 1/1 2/2 6/3 5/4
`;
const enc = (s) => new TextEncoder().encode(s).buffer;

function faceNormal(P, f) {
  const i = 9 * f;
  const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
  const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

test('OBJ cube with vt and two materials', async () => {
  const m = await L.parseBuffer(enc(CUBE_OBJ), 'cube.obj');
  assert.equal(m.format, 'obj');
  assert.equal(m.faceCount, 12);
  assert.equal(m.positions.length, 108);
  assert.ok(m.originalUV && m.originalUV.length === 72);
  assert.equal(m.materials.length, 2);
  assert.ok(m.faceMaterial);
  assert.deepEqual(Array.from(new Set(m.faceMaterial)).sort(), [0, 1]);
  assert.deepEqual(Array.from(m.bbox.min), [-1, -1, -1]);
});

test('OBJ without texture coordinates has no originalUV; two objects merge', async () => {
  const text = 'o a\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no b\nv 0 0 1\nv 1 0 1\nv 0 1 1\nf 4 5 6\n';
  const m = await L.parseBuffer(text, 'two.obj', 'obj');
  assert.equal(m.faceCount, 2);
  assert.equal(m.originalUV, null);
  assert.equal(m.meshCount, 2);
  assert.ok(m.warnings.some(w => /Merged 2/.test(w)));
});

test('ASCII and binary STL', async () => {
  const ascii = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
  const a = await L.parseBuffer(enc(ascii), 'a.stl');
  assert.equal(a.faceCount, 1);
  const buf = new ArrayBuffer(84 + 2 * 50), dv = new DataView(buf);
  dv.setUint32(80, 2, true);
  const tri = [[0, 0, 0, 1, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0, 0, 1, 0]];
  tri.forEach((t, i) => { const o = 84 + i * 50; t.forEach((v, k) => dv.setFloat32(o + 12 + 4 * k, v, true)); });
  assert.equal(L.detectFormat('noext', buf), 'stl');
  const b = await L.parseBuffer(buf, 'b.bin');
  assert.equal(b.format, 'stl');
  assert.equal(b.faceCount, 2);
});

test('PLY with faces loads; a point cloud is rejected clearly', async () => {
  const ply = 'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 2\n3 0 2 3\n';
  const m = await L.parseBuffer(enc(ply), 'q.ply');
  assert.equal(m.faceCount, 2);
  const cloud = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n';
  await assert.rejects(L.parseBuffer(enc(cloud), 'c.ply'), /point cloud/);
});

function gltfWith(nodes) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const b64 = Buffer.from(pos.buffer).toString('base64');
  return JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36, uri: 'data:application/octet-stream;base64,' + b64 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes, scenes: [{ nodes: nodes.map((_, i) => i) }], scene: 0
  });
}

test('glTF JSON: node transforms are applied and mirrored nodes keep outward winding', async () => {
  const m = await L.parseBuffer(gltfWith([{ mesh: 0, translation: [5, 0, 0] }, { mesh: 0, scale: [-1, 1, 1] }]), 'scene.gltf');
  assert.equal(m.faceCount, 2);
  assert.equal(m.positions[0], 5);
  // original triangle normal is +z; the mirrored copy must still face +z
  assert.ok(faceNormal(m.positions, 0)[2] > 0);
  assert.ok(faceNormal(m.positions, 1)[2] > 0, 'mirrored winding fixed');
});

test('GLB produced by GLTFExporter round-trips with UVs', async () => {
  const geo = new THREE.BoxGeometry(1, 2, 3);
  const glb = await new Promise((res, rej) => new THREE.GLTFExporter().parse(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()), res, rej, { binary: true }));
  assert.equal(L.detectFormat('x', glb), 'glb');
  const m = await L.parseBuffer(glb, 'box.glb');
  assert.equal(m.faceCount, 12);
  assert.ok(m.originalUV);
  assert.ok(m.normals);
  assert.ok(Math.abs(m.bbox.max[2] - 1.5) < 1e-6);
});

test('degenerate faces are dropped and per-face arrays stay aligned', async () => {
  const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 2 2 2\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\nf 4/1 4/2 4/3\nf 1/3 3/2 2/1\n';
  const m = await L.parseBuffer(text, 'd.obj', 'obj');
  assert.equal(m.faceCount, 2);
  assert.equal(m.droppedDegenerate, 1);
  assert.equal(m.originalUV.length, 12);
  assert.deepEqual(Array.from(m.originalUV.subarray(6, 12)), [0, 1, 1, 0, 0, 0]);
});

test('detectFormat by extension and magic; errors for unknown files; MTL parsing', async () => {
  assert.equal(L.detectFormat('a.GLB'), 'glb');
  assert.equal(L.detectFormat('scene', enc('{"asset":{"version":"2.0"}}')), 'gltf');
  assert.equal(L.detectFormat('m', enc('# comment\nv 0 0 0\n')), 'obj');
  await assert.rejects(L.parseBuffer(enc('hello'), 'x.txt'), /Unsupported/);
  const mtl = L.parseMTL('newmtl red\nKd 1 0 0\nmap_Kd tex/red.png\n');
  assert.deepEqual(Array.from(mtl.red.color), [1, 0, 0]);
  assert.equal(mtl.red.map, 'tex/red.png');
  await assert.rejects(L.parseBuffer('v 0 0 0\n', 'empty.obj', 'obj'), /No triangle meshes|degenerate/);
});
