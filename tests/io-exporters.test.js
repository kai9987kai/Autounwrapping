'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowser } = require('./load-browser');
const F = require('./fixtures');

const ctx = loadBrowser({ three: ['OBJLoader.js', 'GLTFLoader.js', 'GLTFExporter.js'], scripts: ['src/io/exporters.js'] });
const X = ctx.UVApp.exporters, THREE = ctx.THREE;

function cubeUV() {
  const P = F.cube(), uv = new Float32Array(P.length / 9 * 6);
  for (let c = 0; c < P.length / 3; c++) { uv[2 * c] = (P[3 * c] + P[3 * c + 2] + 1) / 2 % 1; uv[2 * c + 1] = (P[3 * c + 1] + 0.5); }
  return { P, uv };
}

test('OBJ export welds positions, dedups uvs and re-parses to identical corners', () => {
  const { P, uv } = cubeUV();
  const text = X.exportOBJText(P, uv, 'cube');
  assert.equal((text.match(/^v /gm) || []).length, 8);
  const vt = (text.match(/^vt /gm) || []).length;
  assert.ok(vt > 0 && vt < 36);
  const obj = new THREE.OBJLoader().parse(text);
  const g = obj.children[0].geometry;
  assert.equal(g.attributes.position.count, 36);
  for (let c = 0; c < 36; c++) {
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(g.attributes.position.array[3 * c + a] - P[3 * c + a]) < 1e-5);
    assert.ok(Math.abs(g.attributes.uv.array[2 * c] - uv[2 * c]) < 1e-5);
    assert.ok(Math.abs(g.attributes.uv.array[2 * c + 1] - uv[2 * c + 1]) < 1e-5);
  }
});

test('OBJ with normals and materials writes vn and usemtl; MTL export', async () => {
  const { P, uv } = cubeUV();
  const normals = new Float32Array(P.length).fill(0).map((_, i) => i % 3 === 2 ? 1 : 0);
  const fm = new Uint16Array(12).map((_, i) => i < 6 ? 0 : 1);
  const text = X.exportOBJText(P, uv, 'cube', { normals, faceMaterial: fm, materialNames: ['red', 'blue'], mtlFileName: 'cube.mtl' });
  assert.ok(/^vn 0\.000000 0\.000000 1\.000000$/m.test(text));
  assert.equal((text.match(/^usemtl /gm) || []).length, 2);
  assert.ok(/^mtllib cube\.mtl$/m.test(text));
  assert.ok(/^f \d+\/\d+\/\d+ /m.test(text));
  const mtl = await X.exportMTL([{ name: 'red', color: [1, 0, 0], mapFileName: 'red.png' }]).text();
  assert.ok(/newmtl red/.test(mtl) && /map_Kd red\.png/.test(mtl));
});

test('GLB export re-parses with the same corners and TEXCOORD_0', async () => {
  const { P, uv } = cubeUV();
  const blob = await X.exportGLB(P, uv, 'cube');
  const buf = await blob.arrayBuffer();
  const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().parse(buf, '', res, rej));
  let mesh = null;
  gltf.scene.traverse(o => { if (o.isMesh) mesh = o; });
  const g = mesh.geometry, idx = g.index;
  const count = idx ? idx.count : g.attributes.position.count;
  assert.equal(count, 36);
  for (let c = 0; c < 36; c++) {
    const i = idx ? idx.getX(c) : c;
    assert.ok(Math.abs(g.attributes.uv.getX(i) - uv[2 * c]) < 1e-6);
    assert.ok(Math.abs(g.attributes.position.getZ(i) - P[3 * c + 2]) < 1e-6);
  }
});

test('ZIP: CRC-32 test vector and a structurally valid store archive', async () => {
  assert.equal(X.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const blob = await X.makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/ü.bin', data: new Uint8Array([1, 2, 3, 4]) }]);
  const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer);
  const eocd = b.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
  let cd = dv.getUint32(eocd + 16, true);
  const crcRef = (bytes) => { let c = ~0; for (const x of bytes) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const names = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(dv.getUint32(cd, true), 0x02014b50);
    const nameLen = dv.getUint16(cd + 28, true), local = dv.getUint32(cd + 42, true), size = dv.getUint32(cd + 24, true), crc = dv.getUint32(cd + 16, true);
    names.push(new TextDecoder().decode(b.subarray(cd + 46, cd + 46 + nameLen)));
    assert.equal(dv.getUint32(local, true), 0x04034b50);
    const lNameLen = dv.getUint16(local + 26, true);
    const data = b.subarray(local + 30 + lNameLen, local + 30 + lNameLen + size);
    assert.equal(crcRef(data), crc);
    cd += 46 + nameLen;
  }
  assert.deepEqual(names, ['a.txt', 'dir/ü.bin']);
});

test('project save/load round-trips typed arrays (odd lengths, 1e6 elements) and rejects corrupt files', async () => {
  const positions = new Float32Array(9 * 111111).map((_, i) => Math.sin(i));
  const state = { name: 'm', positions, cut: new Uint8Array(7).fill(1), faceChart: new Int32Array(5).map((_, i) => -i), settings: { a: 1, nested: { b: [1, 2] } }, big: new Float64Array(1e6).fill(0.25) };
  const blob = X.saveProject(state);
  const back = await X.loadProject(blob);
  assert.ok(back.positions instanceof ctx.Float32Array || back.positions.constructor.name === 'Float32Array');
  assert.equal(back.positions.length, positions.length);
  assert.equal(back.positions[12345], positions[12345]);
  assert.deepEqual(Array.from(back.faceChart), [0, -1, -2, -3, -4]);
  assert.equal(back.big.length, 1e6);
  assert.equal(back.settings.nested.b[1], 2);
  await assert.rejects(X.loadProject('{"format":"nope"}'), /Not a UV Toolkit project/);
  await assert.rejects(X.loadProject('not json'), /JSON/);
});

test('CSV quoting, report stripping and UV layout drawing into a recording context', async () => {
  const csv = await X.exportCSV([{ a: 'x,y', b: 'say "hi"', c: 'line\nbreak', d: 1.5 }]).text();
  assert.equal(csv, 'a,b,c,d\r\n"x,y","say ""hi""","line\nbreak",1.50000\r\n');
  const rep = JSON.parse(await X.exportReport({ metrics: { chartCount: 2, faces: 4, faceSD: new Float32Array(1000), score: { score: 77, valid: true, explanations: [] }, sdMean: Infinity }, settings: { mode: 'atlas' } }).text());
  assert.equal(rep.summary.score, 77);
  assert.equal(rep.metrics.faceSD, undefined);
  assert.equal(rep.summary.symmetricDirichlet.mean, 'Infinity');
  const calls = { moveTo: 0, lineTo: 0, fill: 0, stroke: 0 };
  const rec = new Proxy({}, { get: (t, k) => k in calls ? () => calls[k]++ : (typeof k === 'string' && /Style|lineWidth|lineJoin/.test(k) ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const uv = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1]);
  X.drawUVLayout(rec, { uv, faceChart: new Int32Array([0, 1]), size: 256, style: 'chart' });
  assert.deepEqual(calls, { moveTo: 2, lineTo: 4, fill: 2, stroke: 2 });
});

test('project validation rejects unsafe keys, non-finite geometry and mismatched arrays', async () => {
  const positions = F.cube();
  const valid = JSON.parse(await X.saveProject({ positions }).text());
  assert.equal(valid.version, 2);
  const unsafe = JSON.stringify(valid).replace('"version":2', '"version":2,"__proto__":{"polluted":true}');
  await assert.rejects(X.loadProject(unsafe), /Unsafe key/);
  await assert.rejects(X.loadProject(X.saveProject({ positions: new Float32Array() })), /mesh positions/);
  const nonfinite = positions.slice(); nonfinite[0] = NaN;
  await assert.rejects(X.loadProject(X.saveProject({ positions: nonfinite })), /non-finite mesh/);
  await assert.rejects(X.loadProject(X.saveProject({ positions, originalUV: new Float32Array(6) })), /source UV/);
  await assert.rejects(X.loadProject(X.saveProject({ positions, normals: new Float32Array(3) })), /normals/);
  valid.positions.$typed = '__proto__';
  await assert.rejects(X.loadProject(JSON.stringify(valid)), /Unknown typed/);
  valid.positions.$typed = 'Float32Array'; valid.positions.b64 = 'A===';
  await assert.rejects(X.loadProject(JSON.stringify(valid)), /base64/);
  const deep = JSON.parse(await X.saveProject({ positions }).text());
  let current = deep;
  for (let i = 0; i < 50; i++) current = current.nested = {};
  await assert.rejects(X.loadProject(JSON.stringify(deep)), /nested too deeply/);
});

test('v1 projects remain readable and disclose missing materials', async () => {
  const old = JSON.parse(await X.saveProject({ positions: F.cube() }).text()); old.version = 1;
  const back = await X.loadProject(JSON.stringify(old));
  assert.ok(back.warnings.some(w => /no saved materials/.test(w)));
  const neutral = await X.restoreMaterials(back.materials);
  assert.equal(neutral.length, 1);
  assert.equal(neutral[0].map, null);
});

test('project snapshots preserve chart membership and reject corrupted face ownership', async () => {
  const browser = loadBrowser({ core: true, scripts: ['src/io/exporters.js'] });
  const engine = new (browser.UVCore.build().UVEngine)();
  const positions = F.cube(); engine.setMesh(positions); engine.unwrap({ mode: 'box' });
  const snapshot = engine.snapshot();
  const good = await browser.UVApp.exporters.loadProject(browser.UVApp.exporters.saveProject({ positions, snapshot }));
  const restored = engine.restore(good.snapshot);
  assert.equal(restored.metrics.faces, positions.length / 9);
  snapshot.chartFaces[0][0] = positions.length / 9;
  await assert.rejects(browser.UVApp.exporters.loadProject(browser.UVApp.exporters.saveProject({ positions, snapshot })), /membership/);
});

test('material project helpers retain colours, texture transforms and sampler settings', async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  let drawn = null;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage: image => { drawn = image; } }; }
    async convertToBlob() { return new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }); }
  }
  const browser = loadBrowser({ three: true, scripts: ['src/io/exporters.js'], globals: { OffscreenCanvas: Canvas } });
  const T = browser.THREE;
  const texture = new T.Texture({ width: 1, height: 1 });
  texture.flipY = false; texture.wrapS = T.RepeatWrapping; texture.wrapT = T.MirroredRepeatWrapping;
  texture.encoding = T.sRGBEncoding; texture.offset.set(0.2, 0.3); texture.repeat.set(2, 3); texture.rotation = 0.4;
  const materials = await browser.UVApp.exporters.captureMaterials([
    { name: 'paint', color: [0.2, 0.4, 0.6], colorSpace: 'linear', map: texture },
    { name: 'trim', color: [1, 0, 0], colorSpace: 'srgb', map: null }
  ]);
  assert.equal(drawn, texture.image);
  assert.equal(materials[0].map.image, 'data:image/png;base64,' + PNG);
  T.TextureLoader = class { load(url, done) { assert.equal(url, materials[0].map.image); done(new T.Texture({ width: 1, height: 1 })); } };
  const restored = await browser.UVApp.exporters.restoreMaterials(materials);
  assert.deepEqual(Array.from(restored[0].color), [0.2, 0.4, 0.6]);
  assert.equal(restored[0].colorSpace, 'linear');
  assert.equal(restored[0].map.flipY, false);
  assert.equal(restored[0].map.wrapT, T.MirroredRepeatWrapping);
  assert.equal(restored[0].map.encoding, T.sRGBEncoding);
  assert.equal(restored[0].map.matrixAutoUpdate, false);
  assert.deepEqual(Array.from(restored[0].map.matrix.elements), Array.from(texture.matrix.elements));
  assert.equal(restored[1].map, null);
  const faceMaterial = new Uint16Array(F.cube().length / 9).fill(1);
  const project = await browser.UVApp.exporters.loadProject(browser.UVApp.exporters.saveProject({ positions: F.cube(), materials, faceMaterial }));
  assert.equal(project.warnings.length, 0);
  faceMaterial[0] = 2;
  await assert.rejects(browser.UVApp.exporters.loadProject(browser.UVApp.exporters.saveProject({ positions: F.cube(), materials, faceMaterial })), /material index/);
  materials[0].map.image = 'https://example.com/texture.png';
  await assert.rejects(browser.UVApp.exporters.restoreMaterials(materials), /embedded/);
});

test('GLB export writes spec-correct glTF uvs (v-down) that the loader turns back into the same v-up layout', async () => {
  const { P, uv } = cubeUV();
  const blob = await X.exportGLB(P, uv, 'cube');
  const buf = await blob.arrayBuffer();
  const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().parse(buf, '', res, rej));
  let mesh = null;
  gltf.scene.traverse(o => { if (o.isMesh) mesh = o; });
  const g = mesh.geometry, idx = g.index;
  for (let c = 0; c < 36; c++) {
    const i = idx ? idx.getX(c) : c;
    assert.ok(Math.abs(g.attributes.uv.getY(i) - (1 - uv[2 * c + 1])) < 1e-6, 'raw glTF v is 1 - v');
  }
  const lctx = loadBrowser({ three: ['GLTFLoader.js'], scripts: ['src/io/loaders.js'] });
  const model = await lctx.UVApp.loaders.parseBuffer(buf, 'cube.glb');
  for (let c = 0; c < 36; c++) assert.ok(Math.abs(model.originalUV[2 * c + 1] - uv[2 * c + 1]) < 1e-5, 'round-trips to v-up');
});
