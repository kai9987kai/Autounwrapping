/* Sparse linear algebra: CSR matrices and preconditioned conjugate gradients.
 * Pure JS (worker + node safe). */
UVCore.define('solvers', function (C) {
  'use strict';
  const EPS = C.EPS;

  /* Accumulates (i, j, v) triplets; duplicates are summed. */
  class TripletBuilder {
    constructor(n) {
      this.n = n;
      this.rows = new Array(n);
      for (let i = 0; i < n; i++) this.rows[i] = new Map();
      this.nnz = 0;
    }
    add(i, j, v) {
      if (v === 0) return;
      const row = this.rows[i];
      const cur = row.get(j);
      if (cur === undefined) { row.set(j, v); this.nnz++; }
      else row.set(j, cur + v);
    }
  }

  /* CSR: rowPtr (n+1), colIdx (nnz), vals (nnz); columns sorted per row. */
  function csrFromTriplets(builder) {
    const n = builder.n;
    const rowPtr = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i] + builder.rows[i].size;
    const nnz = rowPtr[n];
    const colIdx = new Int32Array(nnz);
    const vals = new Float64Array(nnz);
    for (let i = 0; i < n; i++) {
      const cols = Array.from(builder.rows[i].keys()).sort((a, b) => a - b);
      let p = rowPtr[i];
      for (const j of cols) { colIdx[p] = j; vals[p] = builder.rows[i].get(j); p++; }
    }
    return { n, rowPtr, colIdx, vals };
  }

  function csrMulVec(A, x, out) {
    const { n, rowPtr, colIdx, vals } = A;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let p = rowPtr[i], e = rowPtr[i + 1]; p < e; p++) s += vals[p] * x[colIdx[p]];
      out[i] = s;
    }
    return out;
  }

  function csrDiagonal(A) {
    const { n, rowPtr, colIdx, vals } = A;
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let p = rowPtr[i], e = rowPtr[i + 1]; p < e; p++) if (colIdx[p] === i) { d[i] = vals[p]; break; }
    }
    return d;
  }

  /* Returns the 2x2 diagonal block (rows 2k, 2k+1) inverse entries for the
   * block-Jacobi preconditioner on interleaved (u, v) unknowns. */
  function csrBlock2Inverse(A) {
    const { n, rowPtr, colIdx, vals } = A;
    const nb = n >> 1;
    const inv = new Float64Array(nb * 4); // i00 i01 i10 i11
    const at = (i, j) => {
      for (let p = rowPtr[i], e = rowPtr[i + 1]; p < e; p++) if (colIdx[p] === j) return vals[p];
      return 0;
    };
    for (let k = 0; k < nb; k++) {
      const i = 2 * k;
      const a = at(i, i), b = at(i, i + 1), c = at(i + 1, i), d = at(i + 1, i + 1);
      const det = a * d - b * c;
      if (Math.abs(det) > 1e-18 && a > 0 && d > 0) {
        inv[k * 4] = d / det; inv[k * 4 + 1] = -b / det; inv[k * 4 + 2] = -c / det; inv[k * 4 + 3] = a / det;
      } else {
        inv[k * 4] = a > EPS ? 1 / a : 1; inv[k * 4 + 1] = 0; inv[k * 4 + 2] = 0; inv[k * 4 + 3] = d > EPS ? 1 / d : 1;
      }
    }
    return inv;
  }

  /* Preconditioned conjugate gradients for SPD A. Solves A x = b in place
   * (x is the initial guess). Handles consistent singular systems (e.g. a
   * translation null-space) as long as b is in the range of A. */
  function pcg(A, b, x, opts) {
    opts = opts || {};
    const n = A.n;
    const maxIter = opts.maxIter !== undefined ? opts.maxIter : Math.min(2000, 100 + 4 * Math.ceil(Math.sqrt(n)));
    const tol = opts.tol !== undefined ? opts.tol : 1e-8;
    const precond = opts.precond || 'jacobi';
    let applyM;
    if (precond === 'jacobi') {
      const d = csrDiagonal(A);
      const inv = new Float64Array(n);
      for (let i = 0; i < n; i++) inv[i] = d[i] > EPS ? 1 / d[i] : 1;
      applyM = (r, z) => { for (let i = 0; i < n; i++) z[i] = inv[i] * r[i]; };
    } else if (precond === 'block2' && (n & 1) === 0) {
      const inv = csrBlock2Inverse(A);
      applyM = (r, z) => {
        for (let k = 0, nb = n >> 1; k < nb; k++) {
          const i = 2 * k;
          z[i] = inv[k * 4] * r[i] + inv[k * 4 + 1] * r[i + 1];
          z[i + 1] = inv[k * 4 + 2] * r[i] + inv[k * 4 + 3] * r[i + 1];
        }
      };
    } else {
      applyM = (r, z) => { z.set(r); };
    }
    const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    csrMulVec(A, x, Ap);
    let bNorm = 0;
    for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; bNorm += b[i] * b[i]; }
    bNorm = Math.sqrt(bNorm);
    const target = Math.max(tol * bNorm, 1e-300);
    applyM(r, z);
    p.set(z);
    let rz = 0;
    for (let i = 0; i < n; i++) rz += r[i] * z[i];
    let rNorm = 0;
    for (let i = 0; i < n; i++) rNorm += r[i] * r[i];
    rNorm = Math.sqrt(rNorm);
    let iter = 0;
    for (; iter < maxIter && rNorm > target; iter++) {
      csrMulVec(A, p, Ap);
      let pAp = 0;
      for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
      if (!(pAp > 1e-300)) break;
      const alpha = rz / pAp;
      rNorm = 0;
      for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rNorm += r[i] * r[i]; }
      rNorm = Math.sqrt(rNorm);
      if (rNorm <= target) { iter++; break; }
      applyM(r, z);
      let rzNew = 0;
      for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    return { iterations: iter, residual: rNorm, converged: rNorm <= target };
  }

  /* CG on the normal equations A^T A x = A^T b, given matrix-free operators
   * applyA(x, out[nRows]) and applyAT(y, out[nCols]). Optional diagonal
   * preconditioner `diagATA` (Float64Array nCols). */
  function cgLeastSquares(applyA, applyAT, nRows, nCols, b, x, opts) {
    opts = opts || {};
    const maxIter = opts.maxIter !== undefined ? opts.maxIter : Math.min(3000, 200 + 4 * Math.ceil(Math.sqrt(nCols)));
    const tol = opts.tol !== undefined ? opts.tol : 1e-10;
    const inv = new Float64Array(nCols);
    if (opts.diagATA) for (let i = 0; i < nCols; i++) inv[i] = opts.diagATA[i] > EPS ? 1 / opts.diagATA[i] : 1;
    else inv.fill(1);
    const Ax = new Float64Array(nRows), res = new Float64Array(nRows);
    const r = new Float64Array(nCols), z = new Float64Array(nCols), p = new Float64Array(nCols), Ap = new Float64Array(nCols), tmpR = new Float64Array(nRows);
    applyA(x, Ax);
    for (let i = 0; i < nRows; i++) res[i] = b[i] - Ax[i];
    applyAT(res, r);
    for (let i = 0; i < nCols; i++) z[i] = inv[i] * r[i];
    p.set(z);
    let rz = 0, r0 = 0;
    for (let i = 0; i < nCols; i++) { rz += r[i] * z[i]; r0 += r[i] * r[i]; }
    r0 = Math.sqrt(r0);
    const target = Math.max(tol * r0, 1e-300);
    let rNorm = r0, iter = 0;
    for (; iter < maxIter && rNorm > target; iter++) {
      applyA(p, tmpR);
      applyAT(tmpR, Ap);
      let pAp = 0;
      for (let i = 0; i < nCols; i++) pAp += p[i] * Ap[i];
      if (!(pAp > 1e-300)) break;
      const alpha = rz / pAp;
      rNorm = 0;
      for (let i = 0; i < nCols; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rNorm += r[i] * r[i]; }
      rNorm = Math.sqrt(rNorm);
      if (rNorm <= target) { iter++; break; }
      for (let i = 0; i < nCols; i++) z[i] = inv[i] * r[i];
      let rzNew = 0;
      for (let i = 0; i < nCols; i++) rzNew += r[i] * z[i];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < nCols; i++) p[i] = z[i] + beta * p[i];
    }
    return { iterations: iter, residual: rNorm, converged: rNorm <= target };
  }

  return { TripletBuilder, csrFromTriplets, csrMulVec, csrDiagonal, pcg, cgLeastSquares };
});
