'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const C = loadCore();

function inUnit(uv) { for (let i = 0; i < uv.length; i++) if (uv[i] < -1e-6 || uv[i] > 1 + 1e-6) return false; return true; }

test('spherical projection of a sphere stays in [0,1] and no triangle spans the seam', () => {
  const m = C.buildMesh(F.uvSphere(24, 16));
  const r = C.projectSpherical(m);
  assert.ok(inUnit(r.uv));
  let wide = 0;
  for (let f = 0; f < m.faceCount; f++) {
    const i = f * 6;
    const span = Math.max(r.uv[i], r.uv[i + 2], r.uv[i + 4]) - Math.min(r.uv[i], r.uv[i + 2], r.uv[i + 4]);
    if (span > 0.5) wide++;
  }
  assert.equal(wide, 0);
});

test('cylindrical and planar projections cover [0,1] on a cylinder / grid', () => {
  const cyl = C.buildMesh(F.cylinderOpen(24, 4));
  const rc = C.projectCylindrical(cyl);
  assert.ok(inUnit(rc.uv));
  let vMin = 1, vMax = 0;
  for (let c = 0; c < cyl.faceCount * 3; c++) { vMin = Math.min(vMin, rc.uv[c * 2 + 1]); vMax = Math.max(vMax, rc.uv[c * 2 + 1]); }
  assert.ok(vMin < 1e-6 && vMax > 1 - 1e-6);
  const g = C.buildMesh(F.gridPatch(4, 4));
  const rp = C.projectPlanarWhole(g);
  assert.ok(inUnit(rp.uv));
  assert.equal(rp.faceChart.length, g.faceCount);
});
