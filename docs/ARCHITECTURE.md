# Architecture — Advanced 3D UV Toolkit v4

This document is the **contract between modules**. Engineers implementing a
module must follow the interfaces here exactly so that independently written
modules integrate without changes. Where this document and a research paper
disagree on a formula, the paper wins — but the *interface* here is fixed.

## 1. Design goals

1. **No build step.** Classic `<script>` tags only. The app must work when
   `index.html` is opened via `file://` *and* when served (GitHub Pages).
   No ES modules, no `fetch()` of local files, no `importScripts` of local files.
2. **Pure-JS geometry kernel.** Everything under `src/core/` has **no
   dependency on the DOM or Three.js**. It uses only typed arrays, `Math`,
   `Map`/`Set`. That lets it run (a) on the main thread, (b) in a Web Worker
   whose source is generated from the factories' own text (`UVCore.source()`),
   and (c) under `node --test`.
3. **Non-blocking UI.** Heavy work runs in the worker; the UI shows staged
   progress and can cancel.
4. **Correct first, fast second.** Every core module ships with node tests.
   Targets: default torus knot (7,680 faces) full unwrap < 1.5 s in the worker;
   100k faces < 20 s.

## 2. Repository layout

```
index.html                 entry page (markup + script tags only)
src/
  core/                    pure JS kernel (worker/node safe) — DONE: registry, math, solvers, mesh
    registry.js            UVCore.define/build/source
    math.js                EPS, clamp, vec helpers, svd2/polar2, MinHeap, UnionFind, triAngles
    solvers.js             TripletBuilder/CSR, pcg (jacobi|block2|none), cgLeastSquares
    mesh.js                buildMesh (welding, edges, CSR adjacency), connectedComponents, findEdge, edgeSegments
    segmentation.js        chart growth (xatlas-style cost), box, whole
    chart.js               chart-local structure w/ vertex splitting, Euler, loops, cutToDisk
    parameterize.js        planar init, LSCM, Tutte (mean-value / uniform), initChart
    optimize.js            SLIM & ARAP with sparse global solve + line search (+ Anderson, + progressive)
    pack.js                bitmap packing (xatlas/Blender-style) + skyline fallback
    metrics.js             stretch, SD, angle/area, seams, coverage, exact bijectivity, texel density, histogram, score
    projections.js         spherical / cylindrical / planar single-chart projections (DONE)
    engine.js              UVEngine: stateful orchestration, progress, snapshots
    worker-main.js         message loop run inside the worker
  client/
    engine-client.js       EngineClient: worker (Blob URL) with main-thread fallback; Promise API
  io/
    loaders.js             OBJ / glTF / GLB / STL / PLY -> non-indexed positions (Three.js)
    exporters.js           OBJ, GLB, UV PNG (several styles), JSON report, project save/load
  ui/
    styles.css
    textures.js            checker, Blender-style color grid, UDIM grid, gradient (CanvasTexture)
    app.js                 UVToolkit: viewport, materials, overlays, engine calls, undo/redo
    uv-view.js             UV canvas: zoom/pan, hover/select, heat/ID coloring, island drag
    seam-tool.js           3D edge picking for manual seams
    charts.js              Chart.js history line + distortion histogram
    help.js                help chat (knowledge base)
    main.js                DOM wiring, presets, shortcuts, settings persistence, A/B compare, benchmark
vendor/                    pinned third-party libs (three r141 + examples/js, chart.js 3.9.1) — DONE
tests/                     node --test suites (one file per core module) + fixtures.js (DONE)
docs/                      this file, ALGORITHMS.md (citations), CHANGELOG.md
```

Load order (also in `tests/core-order.json`):
`registry, math, solvers, mesh, segmentation, chart, parameterize, optimize, pack, metrics, projections, engine, worker-main`.

## 3. Conventions

* All meshes are **non-indexed triangle soups**: `positions: Float32Array`
  of length `9 * faceCount`; corner `c = f*3 + k` (k = 0..2) has
  `positions[3c .. 3c+2]`. UVs are `Float32Array` of length `6 * faceCount`
  (corner `c` → `uv[2c], uv[2c+1]`).
* Welded vertex ids come from `mesh.cornerWeld[c]`. Edge ids are global,
  undirected, welded (`mesh.faceEdges[3f+k]` is the edge from corner k to k+1;
  `-1` for a degenerate corner edge — always guard for it).
* **Cut flags** (`cut: Uint8Array(mesh.edgeCount)`, 1 = seam) are the single
  mechanism for manual seams, hole-to-boundary cuts and closed-chart cuts.
* Triangle orientation: `tris` in a chart keep the original corner order, so a
  positively-oriented 3D triangle must map to a positively-oriented UV triangle
  (signed area > 0). A negative signed UV area is a **flip**.
* Every core function is pure unless documented as mutating an argument.
* Progress: long functions accept an optional `progress(stage, done, total)`
  callback and an optional `shouldCancel()`; when it returns true they return
  early with `{ cancelled: true }`.
* No `THREE.*`, no `document`, no `window`, no `console` in `src/core`.
* Module pattern: `UVCore.define('name', function (C) { ...; return { ...exports }; });`
  Only `C` (earlier modules' exports), standard globals and `UVCore` may be
  referenced from inside the factory. **Never reference variables outside the
  factory** — the source is re-evaluated in a worker.
* Use `Float64Array` for solver state, `Float32Array` for results sent to the UI.

## 4. Module interfaces

### 4.1 `math.js` (DONE) — exports

```js
EPS, clamp, lerp, safeDiv, v3len, v3dot, v3cross(ax,ay,az,bx,by,bz,out,o), triArea3(9 nums), triNormal3(9 nums,out,o) -> len
svd2(a,b,c,d) -> { s1, s2, cosU, sinU, cosV, sinV }   // J = U diag(s1,s2) V^T, s1>=|s2|, s2<0 iff det<0
polar2(a,b,c,d) -> { cos, sin }                         // U V^T of the signed SVD (= closest rotation)
class MinHeap { push(key,value), pop() -> {key,value}|undefined, peekKey(), size, clear() }
class UnionFind { constructor(n), find(i), union(a,b), count }
hashKey3(x,y,z,quant), triAngles2(x1,y1,x2,y2,x3,y3) -> [a0,a1,a2], triAngles3(9 nums) -> [a0,a1,a2]
```

### 4.2 `solvers.js` (DONE)

```js
class TripletBuilder { constructor(n); add(i, j, v) }   // duplicates summed
csrFromTriplets(builder) -> { n, rowPtr: Int32Array, colIdx: Int32Array, vals: Float64Array }
csrMulVec(A, x, out), csrDiagonal(A)
pcg(A, b, x, { maxIter, tol = 1e-8, precond: 'jacobi' | 'block2' | 'none' }) -> { iterations, residual, converged }
cgLeastSquares(applyA, applyAT, nRows, nCols, b, x, { maxIter, tol, diagATA }) -> same
```
Note: the CSR **pattern** for SLIM/ARAP is fixed per chart; build the
`TripletBuilder` once, and for later iterations refill `vals` in place by
walking the same (row, col) order (keep an index map from per-triangle entries
to `vals` slots) — do not rebuild the Maps every iteration.

### 4.3 `mesh.js` (DONE)

```js
buildMesh(positions: Float32Array, { weldTolerance? }) -> Mesh   // default tolerance = 1e-6 * bbox diagonal
Mesh {
  positions, faceCount,
  cornerWeld: Int32Array(3F), weldCount, weldPos: Float64Array(3W),
  faceNormals: Float32Array(3F), faceAreas: Float32Array(F), faceCentroids: Float32Array(3F),
  edgeCount, edgeVerts: Int32Array(2E) /* a<b */, edgeLengths: Float32Array(E), faceEdges: Int32Array(3F) /* -1 degenerate */,
  edgeFaceStart: Int32Array(E+1), edgeFaceList: Int32Array,
  adjStart: Int32Array(F+1), adjFaces: Int32Array, adjEdges: Int32Array,   // face adjacency CSR + crossed edge
  vertEdgeStart: Int32Array(W+1), vertEdgeList: Int32Array,
  boundaryEdgeCount, nonManifoldEdgeCount, componentCount, bbox: {min,max}, surfaceArea, eulerCharacteristic, weldTolerance
}
faceDihedralCos(mesh, e) -> number         // 1 for boundary / non-manifold edges
connectedComponents(mesh, faces, cut?) -> number[][]
findEdge(mesh, a, b) -> edgeId | -1
edgeSegments(mesh, flags: Uint8Array) -> Float32Array(6 * count)
```

### 4.4 `segmentation.js`

```js
segmentCharts(mesh, opts, cut?: Uint8Array, progress?) -> { faceChart: Int32Array(F), chartFaces: number[][] }
  opts = {
    angleDeg: 50,            // hard limit on deviation from the chart normal
    maxFaces: 6000,          // hard limit per chart (0 = none)
    maxCost: 2.0,            // xatlas default: growth stops when the best candidate's cost exceeds this
    weights: { normal: 2.0, roundness: 0.01, straightness: 6.0, normalSeam: 4.0 },   // xatlas AtlasBuilder defaults
    lloydIterations: 3,      // re-seed from chart centre and regrow (0 = single pass)
    mergeSmallCharts: true, minChartFaces: 3
  }
segmentByAxis(mesh, cut?) -> same shape            // 6 normal buckets, then connected components
segmentWhole(mesh, cut?) -> same shape             // one chart per connected component
```
Contract: every chart is **connected**, never crosses a cut edge, every face
is assigned. Algorithm (xatlas `AtlasBuilder` style):
* seeds: faces sorted by planarity (mean dot with neighbours), plus for
  Lloyd rounds the face closest to each chart's area-weighted centroid whose
  normal is closest to the chart normal;
* all charts grow simultaneously through one global `MinHeap` of
  `(cost, face, chart, generation)`; stale entries (face already assigned, or
  chart normal changed a lot) are re-evaluated on pop;
* cost of adding face `f` to chart `c` across edge `e` from chart face `g`:
  `w.normal*(1 - dot(n_f, N_c)) + w.roundness*roundnessDelta + w.straightness*straightness + w.normalSeam*(1 - dot(n_f, n_g))`
  with `N_c` the area-weighted chart normal, `roundness = perimeter² / (4π·area)`
  (`roundnessDelta = newRoundness - oldRoundness`, clamp ≥ 0), and
  `straightness = (Σ boundary-edge lengths removed − Σ added) / faceEdgeLength`
  negated so that faces filling notches are cheap;
* reject when `dot(n_f, N_c) < cos(angleDeg)`, chart faces ≥ maxFaces, or
  cost > maxCost;
* after every pass, unassigned faces are grouped into connected components and
  become their own charts (they are still re-seeded in the next Lloyd round);
* small charts (< minChartFaces) merge into the neighbour with the closest
  normal when the merged deviation stays under `angleDeg` and no cut edge lies
  between them.
Performance: typed-array queues, no string keys, no `Array.shift()`.
Target: 100k faces, 3 Lloyd rounds < 2 s in node.

### 4.5 `chart.js`

```js
buildChartLocal(mesh, faces: number[] | Int32Array, cut?: Uint8Array) -> Local
Local {
  faces: Int32Array(T),        // global face ids
  nVerts, lp: Float64Array(3n), tris: Int32Array(3T),   // tris[3t+k] = local id of corner faces[t]*3+k
  localWeld: Int32Array(n),    // welded vertex id (several locals may map to one when split along cuts)
  isBoundary: Uint8Array(n),
  boundaryLoops: Int32Array[], // ordered loops of local vertex ids, consistent with triangle winding
  euler: { V, E, F, chi, loops, isDisk },   // isDisk = (chi === 1 && loops === 1)
  uv: Float64Array(2n),        // rest-scale working UV (never overwritten by packing)
  area3D
}
```
Vertex splitting: corners of one welded vertex are merged (union-find) only
across edges that are **not** cut and are interior to the chart (both faces in
the chart). Boundary loops are traced through directed half-edges
(per-triangle), never through a `vertex -> next` map, so pinch vertices with
two outgoing boundary edges are handled (they simply appear in two loops or
twice in one loop).

```js
chartTopology(local) -> euler   (recomputes V, E, F, chi, loops, isDisk from tris)
cutToDisk(mesh, faces, cut: Uint8Array, { maxSplits = 64 } = {}) -> { pieces: number[][], cutsAdded: number, splits: number }
```
Guarantees every returned piece, rebuilt with the (mutated) `cut` flags, has
`euler.isDisk`. Repeat until disk:
1. `loops >= 2` (annulus / holes): shortest vertex path (Dijkstra, 3D edge
   lengths, restricted to chart edges) from the longest loop to any other
   loop; mark its edges cut (`cutsAdded += path length`). One seam instead of a
   split.
2. `loops === 0` (closed) or `chi < 1` with one loop (genus): bisect with a
   two-seed farthest-point BFS on the face graph (`splits++`); each half is
   re-checked. Prefer the two seeds that maximise dual-graph distance.
3. After `maxSplits`, return pieces as-is (engine falls back to projection).
```js
shortestVertexPath(local, sources: Iterable<number>, targets: Set<number>) -> number[] | null
localEdgeToGlobal(mesh, local, a, b) -> edgeId | -1
```

### 4.6 `parameterize.js`

```js
projectPlanar(local)                              // area-weighted normal frame; writes local.uv
solveLSCM(local, { maxIter, tol } = {}) -> { ok, iterations, residual }
tutteEmbed(local, { weights = 'meanvalue' | 'uniform' } = {}) -> boolean
countFlips(local) -> number
initChart(local, method: 'lscm' | 'tutte' | 'projection') -> { method, fallbacks: string[] }
```
* LSCM (Lévy 2002): assemble the conformal rows, pin the two boundary
  vertices that are farthest apart in 3D (two sweeps over the longest loop),
  place pins at (0,0) and (d3D,0), solve **A^T A** via `TripletBuilder` +
  `pcg` (Jacobi) — do not use plain CG on normal equations.
* Tutte (Floater 1997/2003): longest loop → circle by 3D arc length; interior
  solves `Σ_j w_ij (x_i - x_j) = 0` with **mean-value weights**
  `w_ij = (tan(α/2) + tan(β/2)) / |p_i − p_j|` (clamped ≥ 1e-6, tan clamped
  ≤ 1e3); uniform weights as option. Solved with `pcg`. Returns false if no
  boundary loop.
* `initChart`: `lscm` = projectPlanar → LSCM → if flips > 0 → Tutte (record
  fallback); `tutte` = Tutte → if false → LSCM; `projection` = projectPlanar.
  Non-disk charts must use `projection` (engine guarantees disks otherwise).

### 4.7 `optimize.js`

```js
buildRestFrames(local) -> { triArea: Float64Array(T), gx: Float64Array(3T), gy: Float64Array(3T), totalArea }
   // per triangle isometric 2D rest coords (x_j, y_j); gradient operator
   // gx[j] = (y[(j+1)%3] - y[(j+2)%3]) / (2A),  gy[j] = (x[(j+2)%3] - x[(j+1)%3]) / (2A)
   // J = [[Σ gx_j u_j, Σ gy_j u_j], [Σ gx_j v_j, Σ gy_j v_j]]   (a b / c d)
chartEnergy(local, frames, energy = 'sd' | 'arap') -> number
   // sd: Σ_t A_t (fro + fro/det²) / (4 Σ A_t) with fro = a²+b²+c²+d², det = ad−bc; = 1.0 at isometry; +Infinity if any det <= 0
   // arap: Σ_t A_t ‖J_t − R_t‖² / Σ A_t
normalizeChartScale(local, frames)   // scales local.uv so Σ UV area = Σ 3D area (minimiser of SD w.r.t. global scale)
optimizeChart(local, {
    energy = 'sd', iterations = 12, tol = 1e-5,
    globalSolve = 'pcg' | 'jacobi',     // 'pcg' = real SLIM/ARAP global step (default); 'jacobi' = v3-style averaging
    anderson = 5,                        // Anderson acceleration window (0 = off)
    progressive = 'auto' | true | false, // Progressive Parameterization outer loop (Liu 2018) when the start energy > 10 ('auto')
    lineSearch = true
  }, progress?) -> { energyBefore, energyAfter, iterations, flips, converged, history: number[] }
```
SLIM (Rabinovich et al. 2017), per iteration:
1. **local**: for each triangle compute `J`, `svd2` → `s1, s2, U, V`;
   `R = U V^T` (use `polar2`); weights `w_i = sqrt((s_i − s_i^-3)/(s_i − 1))`
   with `s_i` clamped to [1e-2, 1e2] and `w = 2` when `|s_i − 1| < 1e-4`;
   if `s2 <= 0` (flipped at entry) use `w1 = w2 = 1e3`;
   `W = U diag(w1, w2) U^T` (2×2 symmetric) and target `T = W R`.
2. **global**: minimise `Σ_t A_t ‖W_t J_t(x) − T_t‖²_F + p‖x − x_prev‖²`.
   With rows from `B_t` (4×6 over unknowns `u0,u1,u2,v0,v1,v2`):
   `row1: Σ_j (W11 gx_j) u_j + (W12 gx_j) v_j = T11`, `row2` with `gy`/`T12`,
   `row3: Σ_j (W21 gx_j) u_j + (W22 gx_j) v_j = T21`, `row4` with `gy`/`T22`.
   Assemble `K_t = A_t B_tᵀB_t` (6×6) and `rhs_t = A_t B_tᵀ[T11,T12,T21,T22]`
   directly into a `2n × 2n` CSR with **interleaved unknowns** `(u_i, v_i) →
   (2i, 2i+1)`; add the proximal term `p = 1e-4` (chart normalised to total
   rest area 1) on the diagonal and `p·x_prev` to the rhs. Solve with `pcg`
   (`precond: 'block2'`, warm start, tol 1e-6 relative; 1e-4 for the first 3
   iterations). ARAP is the special case `W = I`.
3. **line search**: `d = x* − x`; `α_max` from the per-triangle quadratic
   (smallest positive root of `A0 + αB + α²C = 0`, as in v3's
   `maxFlipFreeStep`); `α = min(1, 0.8 α_max)`; then backtracking on the true
   energy (halve up to 12 times until `E(x + αd) < E(x)`); accept.
4. Stop when `(E_prev − E)/E < tol` or after `iterations`.
* **Anderson acceleration** (Peng et al. 2018, `m = anderson`): treat one
  local-global(+line search) step as `G(x)`; keep ring buffers of `ΔF, ΔG`;
  solve the `m×m` Gram system (regularised 1e-10); accelerated iterate
  `x_AA = g − Σ θ_j ΔG_j`; guard: if `E(x_AA) ≥ E(x)` or it has flips, fall
  back to `g` and reset the history.
* **Progressive Parameterization** (Liu et al. 2018, `K = 60`): when the
  start energy is > 10 (Tutte/planar starts), each outer iteration computes
  per triangle the largest `t ∈ (0,1]` with `D(J(t)) ≤ K` where
  `J(t) = U diag(s1^t, s2^t) V^T`, takes `t_com = min_t`, builds intermediate
  reference triangles `v^r_j = J(t_com)^-1 v^p_j`, replaces `gx, gy, A`
  (uniform weights `1/T`) and runs ONE SLIM iteration; when ≥ 99 % of
  triangles satisfy `D ≤ K`, restore the true rest frames and continue.
* The optimiser runs on **rest-scale UVs** (`normalizeChartScale` first), so
  packing never has to be undone (this was the cause of the v3 "Relax
  explodes after packing" bug).
* Tests must assert: energy history is non-increasing; 0 flips after every
  accepted step; rest-scale invariance; ARAP energy decreases; PCG path
  reaches a lower energy than 'jacobi' in the same iteration count on the
  hemisphere fixture.

### 4.8 `pack.js`

```js
packCharts(charts: Array<{ local: { uv: Float64Array, tris: Int32Array, nVerts }, area3D }>, {
    method = 'bitmap' | 'skyline',
    resolution = 1024,          // target atlas size in texels (also the packing grid)
    paddingTexels = 4,          // Chebyshev dilation in texels (xatlas "padding")
    bilinear = true,            // +1 texel gutter for bilinear filtering (xatlas "bilinear")
    rotations = 4,              // 1 (none), 2 (0/90), 4 (0/90/180/270)
    orientToAxis = true,        // min-area bounding rectangle of the convex hull (not PCA), then "stand up"
    equalizeDensity = true,     // s = sqrt(area3D/areaUV) * texelsPerUnit so every chart has the same density
    searchMs = 0,               // extra randomised restarts within this budget (0 = single deterministic pass)
    blockAlign = false
  }, progress?) -> {
    packedUV: Float32Array[]    // per chart, length 2n, in [0,1] (u right, v up)
    rects: {x,y,w,h}[]          // atlas-space bounding boxes
    transforms: { scale, rotation /* radians */, tx, ty }[],   // maps local.uv -> packed: packed = R(rotation)·(scale·uv) + (tx,ty)
    coverage,                   // set texels incl. padding / R²   (xatlas "utilization")
    chartCoverage,              // set texels of un-padded charts / R²
    efficiency,                 // Σ exact chart UV area (texel²) / (extentW·extentH)   (Limper/Liu/Yang)
    texelsPerUnit, resolution, extent: { w, h }, restarts
  }
```
Bitmap method (xatlas + Blender `uv_pack.cc` refinements; see research notes):
* `BitImage { w, h, stride = ((w+31)>>>5) + 1 (guard word), data: Uint32Array }`
  with `canBlit` (word-wise AND with a 32-phase shift, **witness word** tested
  first) and `blit` (OR).
* Per chart: un-mirror if signed area < 0; orient with the min-area rectangle
  over convex-hull edge directions (Freeman–Shapira), stand up (h ≥ w);
  `s = sqrt(area3D/areaUV)·D`; `w = ceil(ext.x)`, `h = ceil(ext.y)`; texel
  coords `= uv/ext·(w,h) + 0.5 + p`; conservative rasterisation (Hasselgren
  edge offsets; slivers rasterise their edges); `bilinearExpand` (+1) then
  Chebyshev `dilate(p)` word-parallel; D4 images `rot90/180/270` built lazily;
  per-image column profiles `bottom[]`, `topProf[]`; `rasterArea`.
* Order: perimeter `(w+h)` descending, area tie-break; 16 perimeter buckets for
  restart perturbation.
* Atlas: `BitImage(2R+64, 2R+64)` + `top: Int32Array(W)` profile, `extW/extH`.
  Candidates `x ∈ {0} ∪ {b, b−cw : top breakpoints} ∪ {k·step} ∪ {extW}`;
  `y0 = max_i(top[x+i] − bottom[i])` is collision-free by construction;
  metric `m = max(eX,eY)² + eX·eY` evaluated before any bitmap work; bounded
  nesting descent `y0−1, y0−2, …` with `canBlit` to slide under overhangs;
  ties → smaller `max(x,y)`, then higher profile contact, then rotation 0;
  180/270 only for the first 50 charts; small charts (< 0.5 % of R²) also try
  a bottom-left hole scan inside the current extent.
* Scale search: start `D0 = sqrt(R²·0.75/ΣA3)`; secant on `sqrt(D)` (Blender
  `pack_islands_margin_fraction`) until the extent fits `R` within 1 %
  (≤ 10 packs). Padding is in texels so it does not scale with `D`.
* Restarts (if `searchMs > 0`): perturb order inside buckets + random tie
  breaks; keep the smallest extent.
* Final UV `= (place + texel − p)/R`; verify overlap = 0 with un-padded
  images (report `overlapTexels`, expected 0).
* `skyline` keeps v3's algorithm (rectangles) as the fast preview path.
* Tests: no overlapping bits between any two placed un-padded charts; all UVs
  in [0,1]; `rotations = 1` never rotates; bitmap coverage ≥ skyline coverage
  on the sphere/torus-knot fixtures; deterministic for `searchMs = 0`;
  500 synthetic charts at R = 1024 pack in < 1.5 s in node.

### 4.9 `metrics.js`

```js
computeMetrics(mesh, uv: Float32Array, faceChart: Int32Array | null, cut: Uint8Array | null,
               { rasterRes = 512, histogramBins = 32, thresholds = 'game_hero' } = {}) -> Metrics
Metrics {
  faces, corners, chartCount,
  stretchL2, stretchLinf,               // Sander 2001 at global scale (1 = isometric)
  sdMean, sdP99, sdMax,                 // symmetric Dirichlet /4 at global scale; flipped faces excluded and counted
  sdChartOpt,                           // mean SD at each chart's optimal scale (k*⁴ = Q/P)
  angleMeanDeg, angleMaxDeg, angleP95Deg,   // area-weighted
  areaLog2Mean, areaLog2Max,            // |log2(areaUV·gs²/area3D)|
  flipped, flippedAreaFraction, degenerate, outOfRange,
  seamLength3D, seamNorm /* /sqrt(ΣA3) */, seamEdgeCount, seamSegments: Float32Array(6·n),
  coverageExact /* Σ|Auv| */, coverageRaster, overlapTexels,
  bijectivity: { selfIntersectingCharts: number[], overlappingPairs: Array<[a,b]>, containedCharts: number[], valid: boolean },
  texelDensity: { mean, std, min, max, cv },   // per-chart sqrt(areaUV/area3D) relative to the mean (1.0 when equalised)
  faceFlag: Uint8Array(F) /* 0 ok, 1 flipped, 2 degenerate */,
  faceL2: Float32Array(F), faceSD: Float32Array(F), faceAreaLog2: Float32Array(F), cornerAngleErr: Float32Array(3F) /* radians */,
  histogram: { bins: Float32Array, edges: Float32Array, p50, p90, p99 },   // area-weighted, log-spaced, of faceSD
  perChart: Array<{ id, faces, area3D, areaUV, sd, l2, flips, density, seamShare, valid }>,
  grades: { l2, linf, sd, angle, area, td, coverage, validity }  // 'good' | 'ok' | 'bad' vs thresholds preset
  score                                 // lexicographic comparator key: [validity, sdP99 <= bound, J]  (see qualityScore)
}
qualityScore(metrics, { bound = 1.025, wD = 1, wS = 0.05, wP = 0.5, wC = 0.2 }) -> { valid, withinBound, J }
compareMetrics(a, b, opts) -> number   // <0 if a better (lexicographic: valid, withinBound, J)
THRESHOLDS = { game_hero: {...}, vfx: {...}, game_prop: {...}, lightmap: {...} }
blenderStretch(mesh, uv) -> { area: Float32Array(F) /* 0..1 */, angle: Float32Array(3F) /* 0..1 */ }   // Blender 4.x overlay formulas
weightToRgb(w) -> [r,g,b]                 // Blender colormap
```
Rules: seams are edges whose two faces are in different charts, cut edges,
or boundary edges — from topology, never from UV thresholds. Flipped faces
have `SD = +∞` (categorical flag), never a finite score. Bijectivity is exact:
flips + per-chart boundary self-intersection + chart–chart boundary
intersection (uniform grid over boundary edges, cell = median edge length) +
containment (point-in-polygon). One allocation-free typed-array pass over
faces; no per-face object allocation.

### 4.10 `projections.js` (DONE)

```js
projectSpherical(mesh) / projectCylindrical(mesh) / projectPlanarWhole(mesh) -> { uv: Float32Array(6F), faceChart: Int32Array(F) }
```

### 4.11 `engine.js`

```js
class UVEngine {
  setMesh(positions: Float32Array, { weldTolerance } = {}) -> MeshInfo
      // { faceCount, weldCount, edgeCount, boundaryEdgeCount, nonManifoldEdgeCount, componentCount, eulerCharacteristic, surfaceArea, bbox }
  setCut(cut: Uint8Array | null)            // manual seams (length edgeCount); clears auto cuts
  getCut() -> Uint8Array                    // manual + auto cuts added by cutToDisk in the last unwrap
  getManualCut() -> Uint8Array
  toggleSeamEdge(face, k) -> { edge, value } // -1 if degenerate
  seamsFromAngle(deg) -> count               // marks manual seams where dihedral angle > deg
  clearSeams()
  edgeSegments(which: 'manual' | 'all') -> Float32Array
  unwrap(opts, progress?, shouldCancel?) -> UnwrapResult
  relax(opts, progress?) -> UnwrapResult    // optimises rest-scale UVs of existing charts, then repacks
  repack(opts, progress?) -> UnwrapResult
  optimizeSearch(opts, progress?, shouldCancel?) -> { best: UnwrapResult, trials: Array<{ params, metrics, score }> }
      // tries segmentation angles {a−15, a, a+15} ∩ [20,88] (2 if > 30k faces), keeps the lexicographically best (metrics.compareMetrics)
  metrics() -> Metrics
  snapshot() -> Snapshot                    // deep copy of uv + chart locals + cut + opts (for undo)
  restore(snapshot) -> UnwrapResult
}
UnwrapOpts = {
  mode: 'atlas' | 'box' | 'spherical' | 'cylindrical' | 'planar',
  parameterizer: 'lscm' | 'tutte' | 'projection',
  optimizer: 'slim' | 'arap' | 'none', iterations: 12, globalSolve: 'pcg', anderson: 5, progressive: 'auto',
  segmentation: { angleDeg, maxFaces, maxCost, weights, lloydIterations, mergeSmallCharts, minChartFaces },
  packing: { method, resolution, paddingTexels, bilinear, rotations, orientToAxis, equalizeDensity, searchMs },
  thresholds: 'game_hero'
}
UnwrapResult = {
  uv: Float32Array(6F), faceChart: Int32Array(F),
  charts: Array<{ id, faces, nVerts, area3D, areaUV, rect, isDisk, initMethod, fallbacks, energyBefore, energyAfter, flips }>,
  cut: Uint8Array(E), manualCut: Uint8Array(E),
  notes: string[], timings: { segment, topology, flatten, optimize, pack, metrics, total },
  metrics: Metrics, packing: { coverage, efficiency, texelsPerUnit, resolution, extent }
}
```
Stages report `progress('segment'|'topology'|'flatten'|'optimize'|'pack'|'metrics', done, total)`.
For `box`/`atlas` modes every chart goes through `cutToDisk` before
`initChart`; non-disk leftovers get `projection` and a note. `spherical`,
`cylindrical`, `planar` use `projections.js` (one chart). The engine keeps
`charts[i].local` (rest-scale UV) and `packedUV` separately; `relax` operates
on `local.uv` and repacks. `snapshot()` copies `local.uv`, `packedUV`, `cut`.

### 4.12 `worker-main.js` and `client/engine-client.js`

Worker protocol (typed arrays transferred where possible):
```
main -> worker : { id, op: 'setMesh'|'setCut'|'toggleSeamEdge'|'seamsFromAngle'|'clearSeams'|'edgeSegments'|'unwrap'|'relax'|'repack'|'optimizeSearch'|'metrics'|'snapshot'|'restore', args: any[] }
worker -> main : { id, type: 'progress', stage, done, total } | { id, type: 'result', result } | { id, type: 'error', message, stack }
```
`worker-main.js` exports `workerMain(C)` which, when `typeof self.postMessage
=== 'function' && typeof importScripts === 'function'` (i.e. inside a worker),
installs the `onmessage` loop around one `UVEngine`. `EngineClient`
(`src/client/engine-client.js`, runs on the main thread, may use `window`)
exposes the same method names returning Promises, `onProgress(fn)`,
`cancel()` (terminates + respawns the worker, re-sends mesh and manual cut)
and `.mode` (`'worker' | 'main'`). Worker creation:
`new Worker(URL.createObjectURL(new Blob([UVCore.source() + '\nworkerMain(UVCore.build());'], { type: 'text/javascript' })))`.
On failure (exception, or no 'ready' message within 3 s) it falls back to a
direct `UVEngine` on the main thread (progress callbacks still fire).

## 5. UI contracts (Three.js side, classic scripts, global namespace `UVApp`)

All UI files attach to `window.UVApp = window.UVApp || {}`.

### 5.1 `src/ui/textures.js`
```js
UVApp.textures = {
  checker(size = 1024, checks = 16) -> THREE.CanvasTexture,
  colorGrid(size = 2048) -> THREE.CanvasTexture,          // exact Blender Color Grid recipe (hue bands, tint checkers 1/4/32/128, 32px grid, labelled 128px cells)
  udimGrid(size = 2048, tileU = 0, tileV = 0) -> THREE.CanvasTexture,
  gradient(size = 1024) -> THREE.CanvasTexture
}
```
### 5.2 `src/io/loaders.js`
```js
UVApp.loaders.loadFile(file: File) -> Promise<{ positions: Float32Array, name, format: 'obj'|'gltf'|'glb'|'stl'|'ply', meshCount, originalUV: Float32Array | null }>
UVApp.loaders.supportedExtensions -> ['obj','gltf','glb','stl','ply']
```
Merges all meshes with world transforms applied, converts to non-indexed,
drops degenerate faces (zero area) and reports how many were dropped.
### 5.3 `src/io/exporters.js`
```js
UVApp.exporters = {
  downloadBlob(blob, filename),
  exportOBJ(positions, uv, name) -> Blob,            // writes v / vt / f with per-corner vt, welded v by position
  exportGLB(positions, uv, name) -> Promise<Blob>,   // THREE.GLTFExporter binary, includes TEXCOORD_0 and normals
  exportUVPNG({ uv, faceChart, metrics, size = 2048, style: 'wire' | 'chart' | 'heat' | 'checker' }) -> Promise<Blob>,
  exportReport(state) -> Blob,                       // JSON: settings, metrics, per-chart table, pipeline notes, methods/citations
  saveProject(state) -> Blob,                        // JSON with base64 positions/uv/cut + settings + history
  loadProject(file) -> Promise<state>
}
```
### 5.4 `src/ui/uv-view.js`
```js
class UVApp.UVView {
  constructor(canvas)
  setData({ uv, faceChart, charts, metrics, cut, resolution })
  setStyle({ mode: 'chart' | 'heat-sd' | 'heat-l2' | 'blender-area' | 'blender-angle' | 'flips' | 'none', showGrid, showTexelGrid, showChartRects })
  on(event: 'hover' | 'select' | 'islandmove', fn)     // hover/select payload { chartId | -1, u, v }; islandmove { chartId, du, dv }
  select(chartId | -1); getSelected()
  resetView(); zoomTo(rect)
}
```
Wheel zoom about the cursor, drag pan (middle/right or space+left), double-click
reset, chart hit-test by point-in-triangle against `faceChart`. Draws with a
device-pixel-ratio-aware canvas; the hovered/selected chart is outlined.
### 5.5 `src/ui/seam-tool.js`
```js
class UVApp.SeamTool {
  constructor({ app })          // app: UVToolkit (provides camera, renderer, currentMesh, engine, refreshSeamOverlay)
  setEnabled(bool); isEnabled()
  setMode('toggle' | 'add' | 'remove')
}
```
Pointer down on the viewport → raycast the mesh → nearest edge of the hit face
(distance from hit point to the three edge segments) → `engine.toggleSeamEdge`
→ `app.refreshSeamOverlay()`. Shift = remove, Alt = add. Shows a hover
highlight of the candidate edge.
### 5.6 `src/ui/charts.js`
```js
UVApp.charts = { initHistory(canvas), pushHistory(metrics), initHistogram(canvas), setHistogram(metrics), setTheme(dark) }
```
### 5.7 `src/ui/help.js`
```js
UVApp.help = { answer(question) -> string, topics() -> string[] }
```
### 5.8 `src/ui/app.js`
```js
class UVApp.UVToolkit {
  constructor({ container, engine: EngineClient, uvView: UVView, onState(fn) })
  loadPositions(positions, name, { autoUnwrap }) ; loadDefault(name = 'torusKnot' | 'sphere' | 'cube' | 'cylinder' | 'torus' | 'monkey?')
  getSettings() / applySettings(obj)         // UnwrapOpts + view options
  runUnwrap() / runRelax() / runRepack() / runOptimize()  -> Promise<UnwrapResult>   (disables buttons, progress bar, cancel)
  undo() / redo()
  setTextureMode('checker' | 'colorgrid' | 'udim' | 'gradient' | 'none'), setHeatMode(mode), setWireframe(bool), setSeamOverlay(bool), setTurntable(bool)
  highlightChart(chartId | -1)               // vertex-color tint of the chart's faces in 3D
  refreshSeamOverlay()
  screenshot() -> Promise<Blob>
  state: { positions, name, result: UnwrapResult | null, meshInfo, history: MetricsSnapshot[] }
}
```
### 5.9 `src/ui/main.js`
DOM wiring for every control in `index.html`; presets (`Game hero`, `Game
prop`, `Film/VFX`, `Lightmap`, `Fast preview`); settings persistence
(localStorage + URL hash); toasts; keyboard shortcuts + cheat sheet; A/B
compare table (snapshots list, delta table); benchmark runner (procedural
primitives, CSV export); bake-readiness checks (flips, overlap, out-of-range,
padding vs resolution, TD CV) shown as actionable toasts; theme toggle.

## 6. Test plan (tests/*.test.js)

Every core module: one test file, fixtures from `tests/fixtures.js`.
* `segmentation`: cube → 6 charts with box and with atlas (angle 50); sphere
  charts are connected, all faces assigned, never cross a cut; Lloyd rounds do
  not increase chart count on the sphere; maxFaces respected; 30k-face torus
  knot < 1 s.
* `chart`: grid → isDisk; annulus → loops 2, chi 0 → cutToDisk adds one path,
  becomes disk; open cylinder → same; closed sphere → bisected into disks;
  torus (genus 1) → disks after splits; pinch-vertex boundary tracing.
* `parameterize`: LSCM on a planar patch is a similarity of the patch (angle
  error < 1e-6); Tutte (meanvalue) on the hemisphere gives 0 flips and lower SD
  than uniform; initChart fallbacks recorded.
* `optimize`: from a Tutte start on the hemisphere SLIM's energy history is
  non-increasing and ends with 0 flips and SD < 1.2; ARAP decreases; PCG beats
  Jacobi at equal iterations; scaling the input by 10 gives the same energy.
* `pack`: no overlapping bits; UV in [0,1]; rotations=1 never rotates; bitmap
  coverage ≥ skyline coverage; deterministic; 500 charts < 1.5 s.
* `metrics`: isometric map → L2 = 1, SD = 1, angle 0; 2× anisotropic stretch
  gives L2 = √((4+1)/2)/√2 …; flipped face flagged and SD = ∞ excluded; two
  overlapping charts detected exactly; self-intersecting boundary detected;
  seams from chart ids; texel density CV 0 when equalised.
* `engine`: full unwrap of sphere and torus knot: 0 flips, bijectivity.valid,
  all charts isDisk, coverage > 0.6; relax after pack does NOT explode
  (L2 stays < 1.3 and decreases or holds); snapshot/restore round-trip;
  `viaSource` round-trip build works; manual seam splits a chart.

## 7. Fixtures (`tests/fixtures.js`, DONE)

`gridPatch(nx, ny, height?)`, `annulusPatch(nx, ny, hole)`, `uvSphere(segW, segH)`, `hemisphere(segW, segH)`, `cube()`, `cylinderOpen(seg, hseg)`, `torus(...)`, `torusKnot(...)` (matches THREE.TorusKnotGeometry), `signedUVArea`, `mulberry32(seed)`.
