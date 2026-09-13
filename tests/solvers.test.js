'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./load-core');
const { mulberry32 } = require('./fixtures');
const C = loadCore();

function randomSPD(n, rnd) {
  // Laplacian-like, diagonally dominant random sparse SPD matrix
  const tb = new C.TripletBuilder(n);
  for (let i = 0; i < n; i++) {
    let diag = 1 + rnd();
    for (let k = 0; k < 3; k++) {
      const j = Math.floor(rnd() * n);
      if (j === i) continue;
      const v = -rnd();
      tb.add(i, j, v); tb.add(j, i, v);
      diag -= v;
      tb.add(j, j, -v);
    }
    tb.add(i, i, diag);
  }
  return C.csrFromTriplets(tb);
}

for (const precond of ['jacobi', 'block2', 'none']) {
  test('pcg (' + precond + ') solves a random SPD system', () => {
    const rnd = mulberry32(5);
    const n = 200;
    const A = randomSPD(n, rnd);
    const xTrue = new Float64Array(n).map(() => rnd() - 0.5);
    const b = new Float64Array(n);
    C.csrMulVec(A, xTrue, b);
    const x = new Float64Array(n);
    const r = C.pcg(A, b, x, { precond, tol: 1e-10, maxIter: 2000 });
    assert.ok(r.converged, 'converged');
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(x[i] - xTrue[i]));
    assert.ok(err < 1e-6, 'max err ' + err);
  });
}

test('pcg handles a consistent singular (translation null-space) system', () => {
  // Graph Laplacian of a path: singular, b orthogonal to ones
  const n = 50, tb = new C.TripletBuilder(n);
  for (let i = 0; i + 1 < n; i++) { tb.add(i, i, 1); tb.add(i + 1, i + 1, 1); tb.add(i, i + 1, -1); tb.add(i + 1, i, -1); }
  const A = C.csrFromTriplets(tb);
  const xTrue = new Float64Array(n).map((_, i) => Math.sin(i));
  const b = new Float64Array(n);
  C.csrMulVec(A, xTrue, b);
  const x = new Float64Array(n);
  const r = C.pcg(A, b, x, { precond: 'jacobi', tol: 1e-10, maxIter: 5000 });
  assert.ok(r.converged);
  const Ax = new Float64Array(n);
  C.csrMulVec(A, x, Ax);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(Ax[i] - b[i]) < 1e-6);
});

test('csrFromTriplets sums duplicates and sorts columns', () => {
  const tb = new C.TripletBuilder(3);
  tb.add(0, 2, 1); tb.add(0, 1, 2); tb.add(0, 2, 3);
  const A = C.csrFromTriplets(tb);
  assert.deepEqual(Array.from(A.rowPtr), [0, 2, 2, 2]);
  assert.deepEqual(Array.from(A.colIdx), [1, 2]);
  assert.deepEqual(Array.from(A.vals), [2, 4]);
});

test('cgLeastSquares solves an overdetermined system', () => {
  const rows = 40, cols = 10, rnd = mulberry32(9);
  const M = Array.from({ length: rows }, () => Array.from({ length: cols }, () => rnd() - 0.5));
  const xTrue = Array.from({ length: cols }, () => rnd());
  const b = new Float64Array(rows);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) b[i] += M[i][j] * xTrue[j];
  const applyA = (x, out) => { for (let i = 0; i < rows; i++) { let s = 0; for (let j = 0; j < cols; j++) s += M[i][j] * x[j]; out[i] = s; } };
  const applyAT = (y, out) => { out.fill(0); for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out[j] += M[i][j] * y[i]; };
  const x = new Float64Array(cols);
  const r = C.cgLeastSquares(applyA, applyAT, rows, cols, b, x, { tol: 1e-12 });
  assert.ok(r.converged);
  for (let j = 0; j < cols; j++) assert.ok(Math.abs(x[j] - xTrue[j]) < 1e-6);
});
