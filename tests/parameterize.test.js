'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const F = require('./fixtures');
const MODULES = ['math', 'solvers', 'mesh', 'chart', 'parameterize'];
const C = loadCore({ modules: MODULES });

const allFaces = (m) => Array.from({ length: m.faceCount }, (_, i) => i);

function localOf(positions, Cx = C) {
  const m = Cx.buildMesh(positions);
  return { m, L: Cx.buildChartLocal(m, allFaces(m)) };
}

/* Area-weighted symmetric Dirichlet (1 = isometric) and max angle error. */
function distortion(L) {
  const { lp, tris, uv } = L;
  let sd = 0, A = 0, angMax = 0, flips = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [i, j, k] = [tris[t], tris[t + 1], tris[t + 2]];
    const e1 = [lp[3 * j] - lp[3 * i], lp[3 * j + 1] - lp[3 * i + 1], lp[3 * j + 2] - lp[3 * i + 2]];
    const e2 = [lp[3 * k] - lp[3 * i], lp[3 * k + 1] - lp[3 * i + 1], lp[3 * k + 2] - lp[3 * i + 2]];
    const l1 = Math.hypot(...e1);
    const x2 = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1;
    const y2 = Math.sqrt(Math.max(0, e2[0] ** 2 + e2[1] ** 2 + e2[2] ** 2 - x2 * x2));
    const a3 = 0.5 * l1 * y2;
    if (a3 < 1e-14) continue;
    const u1 = uv[2 * j] - uv[2 * i], v1 = uv[2 * j + 1] - uv[2 * i + 1];
    const u2 = uv[2 * k] - uv[2 * i], v2 = uv[2 * k + 1] - uv[2 * i + 1];
    // J = [u1 u2; v1 v2] * inv([l1 x2; 0 y2])
    const a = u1 / l1, b = (u2 - a * x2) / y2, c = v1 / l1, d = (v2 - c * x2) / y2;
    const det = a * d - b * c;
    if (det <= 0) { flips++; continue; }
    const fro = a * a + b * b + c * c + d * d;
    sd += a3 * (fro + fro / (det * det)) / 4; A += a3;
    const s1 = Math.sqrt((fro + Math.sqrt(Math.max(0, fro * fro - 4 * det * det))) / 2), s2 = det / s1;
    angMax = Math.max(angMax, Math.abs(Math.log(s1 / s2)));
  }
  return { sd: sd / A, conformalMax: angMax, flips };
}

test('LSCM on a planar patch is a similarity (conformal error ~ 0)', () => {
  const { L } = localOf(F.gridPatch(10, 7, null, 2, 1));
  const r = C.solveLSCM(L);
  assert.ok(r.ok && r.pins.length === 2);
  const d = distortion(L);
  assert.equal(d.flips, 0);
  assert.ok(d.conformalMax < 1e-6, 'conformal error ' + d.conformalMax);
});

test('LSCM user pins are kept exactly', () => {
  const { L } = localOf(F.hemisphere(16, 6));
  C.projectPlanar(L);
  const pins = [L.boundaryLoops[0][0], L.boundaryLoops[0][5], L.boundaryLoops[0][11]];
  const want = pins.map(p => [L.uv[2 * p] * 1.3 + 0.2, L.uv[2 * p + 1] * 1.3 - 0.1]);
  pins.forEach((p, i) => { L.uv[2 * p] = want[i][0]; L.uv[2 * p + 1] = want[i][1]; });
  C.solveLSCM(L, { pins });
  pins.forEach((p, i) => { assert.equal(L.uv[2 * p], want[i][0]); assert.equal(L.uv[2 * p + 1], want[i][1]); });
  assert.equal(C.countFlips(L), 0);
});

test('BFF: Gauss-Bonnet holds and a planar patch maps to a similarity', () => {
  const { L } = localOf(F.gridPatch(9, 9, null, 1, 3));
  const r = C.solveBFF(L);
  assert.ok(r.ok);
  assert.ok(r.gaussBonnetError < 1e-8, 'GB error ' + r.gaussBonnetError);
  assert.equal(r.flips, 0);
  const d = distortion(L);
  assert.ok(d.conformalMax < 1e-5, 'conformal error ' + d.conformalMax);
  assert.ok(Math.abs(d.sd - 1) < 1e-6, 'sd ' + d.sd);
});

test('BFF on the hemisphere: flip-free, boundary lengths preserved, less stretch than LSCM', () => {
  const pos = F.hemisphere(32, 12);
  const { L } = localOf(pos);
  const r = C.solveBFF(L, { normalize: false });
  assert.ok(r.ok);
  assert.ok(r.gaussBonnetError < 1e-6, 'GB error ' + r.gaussBonnetError);
  assert.equal(r.flips, 0);
  // u_B = 0 -> boundary edge lengths ~ 3D lengths (closure changes them slightly)
  const loop = L.boundaryLoops[0];
  let worst = 0;
  for (let p = 0; p < loop.length; p++) {
    const a = loop[p], b = loop[(p + 1) % loop.length];
    const l3 = Math.hypot(L.lp[3 * a] - L.lp[3 * b], L.lp[3 * a + 1] - L.lp[3 * b + 1], L.lp[3 * a + 2] - L.lp[3 * b + 2]);
    const l2 = Math.hypot(L.uv[2 * a] - L.uv[2 * b], L.uv[2 * a + 1] - L.uv[2 * b + 1]);
    worst = Math.max(worst, Math.abs(l2 / l3 - 1));
  }
  assert.ok(worst < 0.05, 'boundary length ratio off by ' + worst);
  C.normalizeScale(L);
  const bff = distortion(L);
  const { L: L2 } = localOf(pos);
  C.solveLSCM(L2); C.normalizeScale(L2);
  const lscm = distortion(L2);
  assert.equal(lscm.flips, 0);
  assert.ok(bff.sd <= lscm.sd + 1e-3, 'bff sd ' + bff.sd + ' vs lscm ' + lscm.sd);
});

test('Tutte (mean-value) is injective on the hemisphere and beats uniform weights', () => {
  const pos = F.hemisphere(24, 10);
  const { L } = localOf(pos);
  assert.equal(C.tutteEmbed(L, { weights: 'meanvalue' }), true);
  C.normalizeScale(L);
  const mv = distortion(L);
  const { L: Lu } = localOf(pos);
  C.tutteEmbed(Lu, { weights: 'uniform' }); C.normalizeScale(Lu);
  const un = distortion(Lu);
  assert.equal(mv.flips, 0);
  assert.equal(un.flips, 0);
  assert.ok(mv.sd < un.sd, 'meanvalue ' + mv.sd + ' uniform ' + un.sd);
});

test('Tutte refuses a closed chart; initChart projects non-disk charts and records it', () => {
  const { L } = localOf(F.uvSphere(12, 8));
  assert.equal(C.tutteEmbed(L), false);
  const r = C.initChart(L, 'bff');
  assert.equal(r.method, 'projection');
  assert.ok(r.fallbacks.length === 1 && /non-disk/.test(r.fallbacks[0]));
});

test('normalizeScale matches 3D area and un-mirrors a mirrored chart', () => {
  const { L } = localOf(F.gridPatch(4, 4));
  C.projectPlanar(L);
  for (let i = 0; i < L.nVerts; i++) { L.uv[2 * i] *= 5; L.uv[2 * i + 1] *= -5; }
  C.normalizeScale(L);
  assert.ok(Math.abs(C.signedAreaUV(L) - L.area3D) < 1e-9);
  assert.equal(C.countFlips(L), 0);
});

test('initChart (every method) on torus-knot disk pieces: 0 flips, rest scale', () => {
  const m = C.buildMesh(F.torusKnot(0.8, 0.3, 120, 16));
  const cut = new Uint8Array(m.edgeCount);
  const res = C.cutToDisk(m, allFaces(m), cut);
  for (const method of ['bff', 'lscm', 'tutte']) {
    let flips = 0;
    const t0 = performance.now();
    for (let i = 0; i < res.pieces.length; i++) {
      const L = C.buildChartLocal(m, res.pieces[i], cut);
      const r = C.initChart(L, method);
      flips += r.flips;
      assert.ok(Math.abs(C.signedAreaUV(L) - L.area3D) < 1e-6 * L.area3D, method + ' scale');
    }
    assert.equal(flips, 0, method + ' flips');
    assert.ok(performance.now() - t0 < 6000, method + ' too slow');
  }
});

test('viaSource round-trip', () => {
  const CS = loadCore({ viaSource: true, modules: MODULES });
  const m = CS.buildMesh(F.hemisphere(12, 5));
  const L = CS.buildChartLocal(m, allFaces(m));
  const r = CS.initChart(L, 'bff');
  assert.equal(r.method, 'bff');
  assert.equal(r.flips, 0);
});
