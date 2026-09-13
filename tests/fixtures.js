'use strict';
/* Pure-JS mesh generators for tests. Every generator returns a NON-INDEXED
 * triangle soup: Float32Array of length 9 * faceCount (3 corners x xyz),
 * with consistent outward / counter-clockwise winding. */

function soupFromIndexed(verts, indices) {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    out[i * 3] = verts[v]; out[i * 3 + 1] = verts[v + 1]; out[i * 3 + 2] = verts[v + 2];
  }
  return out;
}

/* Flat rectangular patch in the XY plane, z = f(x, y) (default 0).
 * nx, ny = number of quads along each axis. Boundary: one loop (a disk). */
function gridPatch(nx = 8, ny = 8, height = null, sx = 1, sy = 1) {
  const verts = [], idx = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = (i / nx - 0.5) * sx, y = (j / ny - 0.5) * sy;
      verts.push(x, y, height ? height(x, y) : 0);
    }
  }
  const id = (i, j) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      idx.push(id(i, j), id(i + 1, j), id(i + 1, j + 1));
      idx.push(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  }
  return soupFromIndexed(verts, idx);
}

/* Grid patch with a square hole in the middle -> annulus topology
 * (chi = 0, two boundary loops). hole = number of quads removed per side. */
function annulusPatch(nx = 10, ny = 10, hole = 4) {
  const verts = [], idx = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) verts.push(i / nx - 0.5, j / ny - 0.5, 0);
  const id = (i, j) => j * (nx + 1) + i;
  const h0x = Math.floor((nx - hole) / 2), h0y = Math.floor((ny - hole) / 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (i >= h0x && i < h0x + hole && j >= h0y && j < h0y + hole) continue;
      idx.push(id(i, j), id(i + 1, j), id(i + 1, j + 1));
      idx.push(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  }
  return soupFromIndexed(verts, idx);
}

/* Lat-long sphere (closed, genus 0). Pole triangles are true triangles. */
function uvSphere(segW = 24, segH = 16, radius = 1) {
  const verts = [], idx = [];
  for (let j = 0; j <= segH; j++) {
    const theta = j / segH * Math.PI;
    for (let i = 0; i <= segW; i++) {
      const phi = i / segW * Math.PI * 2;
      verts.push(radius * Math.sin(theta) * Math.cos(phi), radius * Math.cos(theta), radius * Math.sin(theta) * Math.sin(phi));
    }
  }
  const id = (i, j) => j * (segW + 1) + i;
  for (let j = 0; j < segH; j++) {
    for (let i = 0; i < segW; i++) {
      const a = id(i, j), b = id(i, j + 1), c = id(i + 1, j + 1), d = id(i + 1, j);
      if (j !== 0) idx.push(a, b, d);
      if (j !== segH - 1) idx.push(b, c, d);
    }
  }
  return soupFromIndexed(verts, idx);
}

/* Upper hemisphere (open at the equator): a disk with strong curvature. */
function hemisphere(segW = 24, segH = 8, radius = 1) {
  const verts = [], idx = [];
  for (let j = 0; j <= segH; j++) {
    const theta = j / segH * (Math.PI / 2);
    for (let i = 0; i <= segW; i++) {
      const phi = i / segW * Math.PI * 2;
      verts.push(radius * Math.sin(theta) * Math.cos(phi), radius * Math.cos(theta), radius * Math.sin(theta) * Math.sin(phi));
    }
  }
  const id = (i, j) => j * (segW + 1) + i;
  for (let j = 0; j < segH; j++) {
    for (let i = 0; i < segW; i++) {
      const a = id(i, j), b = id(i, j + 1), c = id(i + 1, j + 1), d = id(i + 1, j);
      if (j !== 0) idx.push(a, b, d);
      idx.push(b, c, d);
    }
  }
  return soupFromIndexed(verts, idx);
}

/* Axis-aligned unit cube: 8 vertices, 12 triangles, 18 edges after welding. */
function cube(size = 1) {
  const s = size / 2;
  const v = [
    -s, -s, -s,  s, -s, -s,  s, s, -s,  -s, s, -s,   // back  (z = -s) 0..3
    -s, -s,  s,  s, -s,  s,  s, s,  s,  -s, s,  s    // front (z = +s) 4..7
  ];
  const idx = [
    4, 5, 6, 4, 6, 7,       // front  +z
    1, 0, 3, 1, 3, 2,       // back   -z
    5, 1, 2, 5, 2, 6,       // right  +x
    0, 4, 7, 0, 7, 3,       // left   -x
    7, 6, 2, 7, 2, 3,       // top    +y
    0, 1, 5, 0, 5, 4        // bottom -y
  ];
  return soupFromIndexed(v, idx);
}

/* Open cylinder (no caps): annulus topology, chi = 0, two boundary loops. */
function cylinderOpen(seg = 24, hseg = 4, radius = 0.5, height = 2) {
  const verts = [], idx = [];
  for (let j = 0; j <= hseg; j++) {
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2;
      verts.push(radius * Math.cos(a), (j / hseg - 0.5) * height, radius * Math.sin(a));
    }
  }
  const id = (i, j) => j * (seg + 1) + i;
  for (let j = 0; j < hseg; j++) {
    for (let i = 0; i < seg; i++) {
      idx.push(id(i, j), id(i, j + 1), id(i + 1, j + 1));
      idx.push(id(i, j), id(i + 1, j + 1), id(i + 1, j));
    }
  }
  return soupFromIndexed(verts, idx);
}

/* Torus (closed, genus 1). */
function torus(radius = 1, tube = 0.35, radialSeg = 24, tubularSeg = 48) {
  const verts = [], idx = [];
  for (let j = 0; j <= radialSeg; j++) {
    for (let i = 0; i <= tubularSeg; i++) {
      const u = i / tubularSeg * Math.PI * 2, v = j / radialSeg * Math.PI * 2;
      verts.push((radius + tube * Math.cos(v)) * Math.cos(u), (radius + tube * Math.cos(v)) * Math.sin(u), tube * Math.sin(v));
    }
  }
  for (let j = 1; j <= radialSeg; j++) {
    for (let i = 1; i <= tubularSeg; i++) {
      const a = (tubularSeg + 1) * j + i - 1, b = (tubularSeg + 1) * (j - 1) + i - 1;
      const c = (tubularSeg + 1) * (j - 1) + i, d = (tubularSeg + 1) * j + i;
      idx.push(a, b, d, b, c, d);
    }
  }
  return soupFromIndexed(verts, idx);
}

/* Exact replica of THREE.TorusKnotGeometry(radius, tube, tubularSegments,
 * radialSegments, p, q) so node tests match the app's default model. */
function torusKnot(radius = 0.8, tube = 0.3, tubularSegments = 160, radialSegments = 24, p = 2, q = 3) {
  const verts = [], idx = [];
  const curve = (u) => {
    const cu = Math.cos(u), su = Math.sin(u), quOverP = q / p * u, cs = Math.cos(quOverP);
    return [radius * (2 + cs) * 0.5 * cu, radius * (2 + cs) * su * 0.5, radius * Math.sin(quOverP) * 0.5];
  };
  for (let i = 0; i <= tubularSegments; i++) {
    const u = i / tubularSegments * p * Math.PI * 2;
    const P1 = curve(u), P2 = curve(u + 0.01);
    const T = [P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]];
    let N = [P2[0] + P1[0], P2[1] + P1[1], P2[2] + P1[2]];
    let B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    N = [B[1] * T[2] - B[2] * T[1], B[2] * T[0] - B[0] * T[2], B[0] * T[1] - B[1] * T[0]];
    const bl = Math.hypot(B[0], B[1], B[2]) || 1, nl = Math.hypot(N[0], N[1], N[2]) || 1;
    B = B.map(x => x / bl); N = N.map(x => x / nl);
    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments * Math.PI * 2;
      const cx = -tube * Math.cos(v), cy = tube * Math.sin(v);
      verts.push(P1[0] + (cx * N[0] + cy * B[0]), P1[1] + (cx * N[1] + cy * B[1]), P1[2] + (cx * N[2] + cy * B[2]));
    }
  }
  for (let j = 1; j <= tubularSegments; j++) {
    for (let i = 1; i <= radialSegments; i++) {
      const a = (radialSegments + 1) * (j - 1) + (i - 1);
      const b = (radialSegments + 1) * j + (i - 1);
      const c = (radialSegments + 1) * j + i;
      const d = (radialSegments + 1) * (j - 1) + i;
      idx.push(a, b, d, b, c, d);
    }
  }
  return soupFromIndexed(verts, idx);
}

/* Helpers used by many tests */
function faceCountOf(positions) { return positions.length / 9; }

function signedUVArea(uv, c0, c1, c2) {
  return 0.5 * ((uv[c1 * 2] - uv[c0 * 2]) * (uv[c2 * 2 + 1] - uv[c0 * 2 + 1]) - (uv[c2 * 2] - uv[c0 * 2]) * (uv[c1 * 2 + 1] - uv[c0 * 2 + 1]));
}

/* Deterministic PRNG for reproducible randomised tests */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

module.exports = { soupFromIndexed, gridPatch, annulusPatch, uvSphere, hemisphere, cube, cylinderOpen, torus, torusKnot, faceCountOf, signedUVArea, mulberry32 };
