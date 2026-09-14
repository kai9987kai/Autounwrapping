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

function quadGltf({ normalizedUV }) {
  // quad in XY facing +z; glTF uv convention: v = 0 at the TOP of the image
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uvF = [0, 1, 1, 1, 1, 0, 0, 0];            // bottom-left vertex -> v = 1 in glTF
  const uv = normalizedUV ? new Uint16Array(uvF.map(v => v * 65535)) : new Float32Array(uvF);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const pad4 = (n) => (n + 3) & ~3;
  const chunks = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer)];
  const offs = []; let o = 0;
  const parts = chunks.map(c => { offs.push(o); const p = Buffer.alloc(pad4(c.length)); c.copy(p); o += p.length; return p; });
  const bin = Buffer.concat(parts);
  return JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }],
    bufferViews: chunks.map((c, i) => ({ buffer: 0, byteOffset: offs[i], byteLength: c.length })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      normalizedUV ? { bufferView: 1, componentType: 5123, normalized: true, count: 4, type: 'VEC2' } : { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
  });
}
function signedUV(uv, f) {
  const i = 6 * f;
  return (uv[i + 2] - uv[i]) * (uv[i + 5] - uv[i + 1]) - (uv[i + 4] - uv[i]) * (uv[i + 3] - uv[i + 1]);
}

test('glTF uvs are normalised to v-up (a correctly mapped glTF is not "flipped"), quantized uvs are denormalised', async () => {
  for (const normalizedUV of [false, true]) {
    const m = await L.parseBuffer(quadGltf({ normalizedUV }), 'quad.gltf');
    assert.equal(m.faceCount, 2);
    for (const v of m.originalUV) assert.ok(v >= -1e-6 && v <= 1 + 1e-6, 'uv in [0,1]: ' + v);
    // bottom-left corner (0,0,0) must map to uv (0,0) in v-up convention
    assert.ok(Math.abs(m.originalUV[0]) < 1e-4 && Math.abs(m.originalUV[1]) < 1e-4, Array.from(m.originalUV.subarray(0, 2)).join(','));
    assert.ok(signedUV(m.originalUV, 0) > 0 && signedUV(m.originalUV, 1) > 0, 'positively oriented');
    assert.equal(m.materials[0].colorSpace, 'linear');
  }
});

test('MTL map paths keep spaces and skip option flags; % in file names does not abort loading', async () => {
  const mtl = L.parseMTL(['newmtl a', 'map_Kd -s 2 2 1 -clamp on tex/wood grain.png', 'newmtl b', 'map_Kd 100%_rough.png'].join('\n'));
  assert.equal(mtl.a.map, 'tex/wood grain.png');
  assert.equal(mtl.b.map, '100%_rough.png');
  const obj = 'mtllib 50%off.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl a\nf 1 2 3\n';
  let asked = null;
  const m = await L.parseBuffer(obj, 'a.obj', 'obj', { sidecarText: async (n) => { asked = n; return 'newmtl a\nKd 1 0 0\n'; } });
  assert.equal(asked, '50%off.mtl');
  assert.equal(m.faceCount, 1);
  assert.equal(m.materials[0].colorSpace, 'srgb');
});
