'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const { mulberry32 } = require('./fixtures');
const MODULES = ['math', 'pack'];
const C = loadCore({ modules: MODULES });

/* ---- synthetic charts (rest-scale uv, isometric so area3D = uv area) ---- */
function grid(w, h, nx = 2, ny = 2, rot = 0, mirror = false) {
  const uv = [], tris = [];
  const cs = Math.cos(rot), sn = Math.sin(rot);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const x = i / nx * w, y = (mirror ? -1 : 1) * j / ny * h;
    uv.push(cs * x - sn * y, sn * x + cs * y);
  }
  const id = (i, j) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    tris.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  }
  return chartOf(uv, tris);
}
function lShape(s) {
  const uv = [0, 0, 2 * s, 0, 2 * s, s, s, s, s, 2 * s, 0, 2 * s];
  return chartOf(uv, [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);
}
function ring(outer, inner) {
  const o = outer / 2, i = inner / 2;
  const uv = [-o, -o, o, -o, o, o, -o, o, -i, -i, i, -i, i, i, -i, i];
  const q = (a, b, c, d) => [a, b, c, a, c, d];
  const tris = [...q(0, 1, 5, 4), ...q(1, 2, 6, 5), ...q(2, 3, 7, 6), ...q(3, 0, 4, 7)];
  return chartOf(uv, tris);
}
function sliver(len) { return chartOf([0, 0, len, 0, len * 0.5, len * 0.01], [0, 1, 2]); }
function chartOf(uvArr, trisArr, area3D) {
  const uv = Float64Array.from(uvArr), tris = Int32Array.from(trisArr);
  let a = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const p = tris[t] * 2, q = tris[t + 1] * 2, r = tris[t + 2] * 2;
    a += 0.5 * ((uv[q] - uv[p]) * (uv[r + 1] - uv[p + 1]) - (uv[r] - uv[p]) * (uv[q + 1] - uv[p + 1]));
  }
  return { local: { uv, tris, nVerts: uv.length / 2 }, area3D: area3D !== undefined ? area3D : Math.abs(a) };
}
function randomSet(n, seed) {
  const rnd = mulberry32(seed), out = [];
  for (let i = 0; i < n; i++) {
    const kind = rnd();
    if (kind < 0.6) out.push(grid(0.2 + rnd() * 2, 0.2 + rnd() * 2, 1 + (rnd() * 3 | 0), 1 + (rnd() * 3 | 0), rnd() * 6));
    else if (kind < 0.85) out.push(lShape(0.3 + rnd()));
    else out.push(sliver(0.5 + rnd()));
  }
  return out;
}

/* Rasterise packed charts at R (conservative), returning per-chart byte images. */
function rasters(res, charts, R) {
  return charts.map((ch, i) => {
    const uv = res.packedUV[i];
    const xs = new Float64Array(uv.length / 2), ys = new Float64Array(uv.length / 2);
    for (let k = 0; k < xs.length; k++) { xs[k] = uv[2 * k] * R; ys[k] = uv[2 * k + 1] * R; }
    return C._rasterize(xs, ys, ch.local.tris, R, R);
  });
}
function overlapCount(imgs, dilateBy, R) {
  const owner = new Int32Array(R * R).fill(-1);
  let overlaps = 0;
  imgs.forEach((img, i) => { for (let p = 0; p < img.length; p++) if (img[p]) { if (owner[p] >= 0 && owner[p] !== i) overlaps++; owner[p] = i; } });
  if (!dilateBy) return overlaps;
  let near = 0;
  imgs.forEach((img, i) => {
    const d = C._dilate(img, R, R, dilateBy);
    for (let p = 0; p < d.length; p++) if (d[p] && owner[p] >= 0 && owner[p] !== i) near++;
  });
  return near;
}
const inUnit = (res) => res.packedUV.every(uv => uv.every(v => v >= 0 && v <= 1));

test('bitmap packing: no overlaps, padding gap respected, UVs in [0,1], zero verified overlap', () => {
  const R = 512, charts = randomSet(60, 3);
  const res = C.packCharts(charts, { resolution: R, paddingTexels: 4 });
  assert.equal(res.packedUV.length, 60);
  assert.ok(inUnit(res));
  assert.equal(res.overlapTexels, 0);
  const imgs = rasters(res, charts, R);
  assert.equal(overlapCount(imgs, 0, R), 0, 'overlapping texels');
  assert.equal(overlapCount(imgs, 3, R), 0, 'charts closer than padding');
  assert.ok(Math.max(res.extent.w, res.extent.h) > 0.9, 'extent ' + JSON.stringify(res.extent));
});

test('transforms map local uv to packed uv', () => {
  const charts = randomSet(12, 9);
  const res = C.packCharts(charts, { resolution: 256, paddingTexels: 2 });
  charts.forEach((ch, i) => {
    const { scale, rotation, tx, ty } = res.transforms[i];
    const cs = Math.cos(rotation), sn = Math.sin(rotation);
    for (let v = 0; v < ch.local.nVerts; v++) {
      const x = scale * ch.local.uv[2 * v], y = scale * ch.local.uv[2 * v + 1];
      assert.ok(Math.abs(cs * x - sn * y + tx - res.packedUV[i][2 * v]) < 2e-5);
      assert.ok(Math.abs(sn * x + cs * y + ty - res.packedUV[i][2 * v + 1]) < 2e-5);
    }
  });
});

test('rotations = 1 with orientToAxis = false never rotates; deterministic output', () => {
  const charts = randomSet(30, 5);
  const a = C.packCharts(charts, { resolution: 256, rotations: 1, orientToAxis: false });
  for (const t of a.transforms) assert.equal(t.rotation, 0);
  const b = C.packCharts(charts, { resolution: 256, rotations: 1, orientToAxis: false });
  a.packedUV.forEach((uv, i) => assert.deepEqual(Array.from(uv), Array.from(b.packedUV[i])));
});

test('bitmap packs tighter than skyline (higher texel density)', () => {
  const charts = [...randomSet(40, 11), ring(3, 2), lShape(1.5), lShape(1.2)];
  const bm = C.packCharts(charts, { resolution: 512, method: 'bitmap' });
  const sk = C.packCharts(charts, { resolution: 512, method: 'skyline' });
  assert.ok(inUnit(sk));
  assert.ok(bm.texelsPerUnit >= sk.texelsPerUnit, 'bitmap D ' + bm.texelsPerUnit + ' skyline D ' + sk.texelsPerUnit);
  assert.ok(bm.efficiency >= sk.efficiency, 'efficiency ' + bm.efficiency + ' vs ' + sk.efficiency);
});

test('a small chart nests inside the hole of a ring', () => {
  const charts = [ring(4, 3), grid(0.5, 0.5)];
  const res = C.packCharts(charts, { resolution: 256, paddingTexels: 2, rotations: 1, orientToAxis: false });
  const r = res.rects[0], s = res.rects[1];
  assert.ok(s.x > r.x && s.y > r.y && s.x + s.w < r.x + r.w && s.y + s.h < r.y + r.h, JSON.stringify(res.rects));
});

test('equalizeDensity: packed scale is proportional to sqrt(area3D / areaUV)', () => {
  const charts = [grid(1, 1), grid(1, 1), grid(2, 1)];
  charts[1].area3D = 4;   // twice the linear density
  charts[2].area3D = 0.5; // quarter area per UV area
  const res = C.packCharts(charts, { resolution: 256 });
  const base = res.transforms[0].scale;
  assert.ok(Math.abs(res.transforms[1].scale / base - 2) < 1e-9);
  assert.ok(Math.abs(res.transforms[2].scale / base - 0.5) < 1e-9);
  const off = C.packCharts(charts, { resolution: 256, equalizeDensity: false });
  assert.ok(Math.abs(off.transforms[1].scale / off.transforms[0].scale - 1) < 1e-9);
});

test('mirrored charts are packed without being flipped and are reported', () => {
  const charts = [grid(1, 1, 2, 2, 0, true), grid(1, 1)];
  const res = C.packCharts(charts, { resolution: 128 });
  assert.deepEqual(Array.from(res.mirroredCharts), [0]);
  const uv = res.packedUV[0], t = charts[0].local.tris;
  const s = (uv[2 * t[1]] - uv[2 * t[0]]) * (uv[2 * t[2] + 1] - uv[2 * t[0] + 1]) - (uv[2 * t[2]] - uv[2 * t[0]]) * (uv[2 * t[1] + 1] - uv[2 * t[0] + 1]);
  assert.ok(s < 0, 'orientation preserved');
});

test('degenerate input: empty list, zero-area chart, single sliver', () => {
  assert.equal(C.packCharts([], {}).packedUV.length, 0);
  const res = C.packCharts([chartOf([0, 0, 0, 0, 0, 0], [0, 1, 2], 0), sliver(1)], { resolution: 64 });
  assert.ok(inUnit(res));
  for (const uv of res.packedUV) for (const v of uv) assert.ok(Number.isFinite(v));
});

test('500 synthetic charts at R = 1024 pack quickly', () => {
  const charts = randomSet(500, 42);
  const t0 = performance.now();
  const res = C.packCharts(charts, { resolution: 1024 });
  const ms = performance.now() - t0;
  assert.equal(res.overlapTexels, 0);
  assert.ok(inUnit(res));
  assert.ok(ms < 8000, 'took ' + ms.toFixed(0) + ' ms');
});

test('viaSource round-trip', () => {
  const CS = loadCore({ viaSource: true, modules: MODULES });
  const res = CS.packCharts(randomSet(10, 1), { resolution: 128 });
  assert.equal(res.overlapTexels, 0);
});
