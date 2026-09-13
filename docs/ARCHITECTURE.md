# Architecture — Advanced 3D UV Toolkit v4

This document is the contract between modules. Engineers implementing a module
must follow the interfaces here exactly so that independently written modules
integrate without changes.

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

## 2. Repository layout

```
index.html                 entry page (markup only; scripts at the bottom)
src/
  core/                    pure JS kernel (worker/node safe)
    registry.js            UVCore.define/build/source  (DONE)
    math.js                EPS, clamp, vec helpers, 2x2 SVD, heap, union-find
    solvers.js             CSR sparse matrix, Jacobi/block-Jacobi PCG
    mesh.js                welding, edges, adjacency (CSR), topology stats
    segmentation.js        chart growth (xatlas-style cost), box, connected split
    chart.js               chart-local structure w/ vertex splitting, Euler, loops, cut-to-disk
    parameterize.js        planar init, LSCM, Tutte (uniform / mean-value)
    optimize.js            SLIM & ARAP local/global with sparse global solve + line search
    pack.js                bitmap packing (xatlas-style) + skyline fallback
    metrics.js             Sander stretch, sym. Dirichlet, angle/area distortion, seams, coverage, overlap, texel density
    projections.js         spherical / cylindrical / planar single-chart projections
    engine.js              UVEngine: stateful orchestration, progress, snapshots
    worker-main.js         message loop run inside the worker (factory text is serialised)
  client/
    engine-client.js       EngineClient: worker (Blob URL) with main-thread fallback; Promise API
  io/
    loaders.js             OBJ / glTF / GLB / STL / PLY -> non-indexed positions (Three.js)
    exporters.js           OBJ, GLB, UV PNG (several styles), JSON report, project save/load
  ui/
    styles.css
    app.js                 UVToolkit: viewport, materials, overlays, engine calls, undo
    uv-view.js             UV canvas: zoom/pan, hover/select, heat/ID coloring
    seam-tool.js           3D edge picking for manual seams
    charts.js              Chart.js history line + distortion histogram
    help.js                help chat
    main.js                DOM wiring, presets, shortcuts, settings persistence, A/B compare, benchmark
vendor/                    pinned third-party libs (three r141 + examples/js, chart.js 3.9.1)
tests/                     node --test suites (one file per core module) + fixtures
docs/                      this file, ALGORITHMS.md (citations), CHANGELOG.md
```

Load order in `index.html` (and `tests/core-order.json`):
`registry, math, solvers, mesh, segmentation, chart, parameterize, optimize, pack, metrics, projections, engine, worker-main`.

## 3. Conventions

* All meshes are **non-indexed triangle soups**: `positions: Float32Array`
  of length `9 * faceCount`; corner `c = f*3 + k` (k = 0..2) has
  `positions[3c .. 3c+2]`. UVs are `Float32Array` of length `6 * faceCount`
  (corner `c` → `uv[2c], uv[2c+1]`).
* Welded vertex ids come from `mesh.cornerWeld[c]`.
* Edge ids are global, undirected, welded (see `mesh.js`). **Cut flags**
  (`cut: Uint8Array(mesh.edgeCount)`, 1 = seam) are the single mechanism for
  manual seams, hole-to-boundary cuts and closed-chart cuts.
* Triangle orientation: `tris` in a chart keep the original corner order, so a
  positively-oriented 3D triangle must map to a positively-oriented UV triangle
  (signed area > 0). A negative signed UV area is a **flip**.
* Every core function is pure unless documented as mutating an argument.
* Progress: long functions accept an optional `progress(stage, done, total)`
  callback and an optional `shouldCancel()` function; they return early with
  `{ cancelled: true }` when it returns true.
* No `THREE.*`, no `document`, no `window`, no `console` (except in engine
  error paths guarded by `typeof console !== 'undefined'`).

## 4. Module interfaces

### 4.1 `math.js`  → exports

```js
EPS = 1e-9
clamp(v, lo, hi), lerp(a, b, t), safeDiv(a, b)
// flat vec3 helpers operating on (array, offset)
v3len(x,y,z), v3dot(ax,ay,az,bx,by,bz), v3cross(ax..bz, out, o)
triArea3(px,py,pz, qx,qy,qz, rx,ry,rz)            // 3D triangle area
triNormal3(p,q,r..., out, o)                       // unit normal, returns length (0 if degenerate)
svd2(a, b, c, d) -> { s1, s2, cosU, sinU, cosV, sinV }
    // signed SVD of J=[[a,b],[c,d]] : J = U diag(s1,s2) V^T, s1 >= |s2|, s2 < 0 iff det(J) < 0
polar2(a, b, c, d) -> { cos, sin }                  // closest rotation of J (det>0 branch)
class MinHeap { push(key, value), pop() -> {key,value} | undefined, size }
class UnionFind { constructor(n), find(i), union(a,b), count }
hashKey3(x, y, z, quant) -> string                  // quantised position key
```

### 4.2 `solvers.js`

```js
class TripletBuilder { constructor(n) add(i, j, v) }        // accumulates duplicates
csrFromTriplets(builder) -> { n, rowPtr: Int32Array, colIdx: Int32Array, vals: Float64Array }
csrMulVec(A, x, out)
pcg(A, b, x, { maxIter = 500, tol = 1e-8, precond = 'jacobi' | 'block2' | 'none' }) -> { iterations, residual, converged }
    // block2: 2x2 block-Jacobi for interleaved (u,v) unknowns (rows 2i, 2i+1)
cgLeastSquares(applyA, applyAT, nRows, nCols, b, x, opts)  // CG on normal equations (kept for LSCM option)
```

### 4.3 `mesh.js`

```js
buildMesh(positions: Float32Array, { weldTolerance = 1e-5 } = {}) -> Mesh
Mesh {
  positions, faceCount,
  cornerWeld: Int32Array(3F), weldCount, weldPos: Float64Array(3W),
  faceNormals: Float32Array(3F), faceAreas: Float32Array(F), faceCentroids: Float32Array(3F),
  edgeCount, edgeVerts: Int32Array(2E)  /* a<b welded ids */, edgeLengths: Float32Array(E),
  faceEdges: Int32Array(3F)             /* edge id of corner edge (k -> k+1) */,
  edgeFaceStart: Int32Array(E+1), edgeFaceList: Int32Array  /* CSR faces per edge */,
  adjStart: Int32Array(F+1), adjFaces: Int32Array, adjEdges: Int32Array /* face adjacency CSR; adjEdges[i] = edge crossed */,
  vertEdgeStart: Int32Array(W+1), vertEdgeList: Int32Array   /* edges around welded vertex */,
  boundaryEdgeCount, nonManifoldEdgeCount, componentCount,
  bbox: { min: [x,y,z], max: [x,y,z] }, surfaceArea, eulerCharacteristic /* W - E + F */
}
faceDihedralCos(mesh, edgeId) -> number    // dot of normals of the two faces (1 if boundary)
connectedComponents(mesh, faces: Int32Array|number[], cut?: Uint8Array) -> number[][]   // within a face subset, not crossing cut edges
```

### 4.4 `segmentation.js`

```js
segmentCharts(mesh, opts, cut?: Uint8Array) -> { faceChart: Int32Array(F), chartFaces: number[][] }
  opts = {
    angleDeg: 50,            // max deviation from chart normal (hard limit)
    maxFaces: 6000,          // hard limit per chart
    maxCost: 2.0,            // growth stops when best candidate cost exceeds this (xatlas default 2)
    weights: { normal: 2.0, roundness: 0.01, straightness: 6.0, normalSeam: 4.0 },  // xatlas defaults
    lloydIterations: 3,      // re-seed from chart centre and regrow
    mergeSmallCharts: true, minChartFaces: 3
  }
  // Every returned chart is CONNECTED and never crosses a cut edge.
segmentByAxis(mesh, cut?) -> same shape (6 normal buckets, then split into connected components)
segmentWhole(mesh, cut?) -> same shape (single chart per connected component)
```

Growth algorithm (xatlas `AtlasBuilder` style): seeds = faces sorted by
planarity; all charts grow simultaneously through a global min-heap of
`(cost, face, chart)` candidates; cost of adding face `f` to chart `c` across
edge `e` =
`w.normal * (1 - dot(n_f, N_c)) + w.roundness * roundnessDelta + w.straightness * straightness + w.normalSeam * (1 - dot(n_f, n_neighbor))`
where `N_c` is the area-weighted chart normal (renormalised as the chart grows),
`roundness = perimeter^2 / (4*pi*area)` compared before/after, and
`straightness` rewards faces whose other edges are already adjacent to the
chart (shrinking the boundary). Reject when `dot(n_f, N_c) < cos(angleDeg)`,
faces ≥ maxFaces, or cost > maxCost. After a pass, each chart re-seeds from the
face closest to its area-weighted centroid with the most chart-like normal and
the process repeats `lloydIterations` times (stop early if seeds don't move).
Unassigned faces become their own charts (connected components). Small charts
(< minChartFaces) are merged into the neighbour with the closest normal when
the merged normal deviation stays under `angleDeg`.

### 4.5 `chart.js`

```js
buildChartLocal(mesh, faces: number[], cut?: Uint8Array) -> Local
Local {
  faces: Int32Array(T),        // global face ids
  nVerts, lp: Float64Array(3n), tris: Int32Array(3T),   // tris[3t+k] = local id of corner faces[t]*3+k
  localWeld: Int32Array(n),    // welded vertex id (several locals may share one when split along cuts)
  isBoundary: Uint8Array(n),
  boundaryLoops: Int32Array[], // each an ordered loop of local vertex ids (consistent orientation)
  euler: { V, E, F, chi, loops, isDisk },   // isDisk = (chi === 1 && loops === 1)
  uv: Float64Array(2n),        // rest-scale working UV (never overwritten by packing)
  area3D
}
```
Vertex splitting: corners of the same welded vertex are merged (union-find)
only across edges that are **not** cut and that are interior to the chart.
Boundary loops are traced through half-edges (per-triangle directed edges),
never through a vertex map, so pinch vertices with two outgoing boundary
edges are handled.

```js
cutToDisk(mesh, faces: number[], cut: Uint8Array, { maxSplits = 64 } = {}) -> { pieces: number[][], cutsAdded: number, splits: number }
```
Guarantees every returned piece, when rebuilt with the (mutated) `cut`
flags, satisfies `euler.isDisk`. Strategy, repeated until disk:
1. `loops >= 2` (annulus, holes): find the shortest vertex path (Dijkstra on
   chart edges weighted by 3D length) from the longest loop to any other loop
   and mark its edges cut (`cutsAdded`). This joins the hole to the outer
   boundary with a single seam instead of splitting the chart.
2. `loops === 0` (closed) or `chi < 1` with one loop (genus): bisect with a
   two-seed farthest-point BFS on the face graph (as v3 did) — `splits++`.
3. Fallback after `maxSplits`: return pieces as-is (engine will use projection).

```js
shortestVertexPath(local, sources: Iterable<number>, targets: Set<number>) -> number[] | null   // local vertex path
localEdgeToGlobal(mesh, local, a, b) -> edgeId
```

### 4.6 `parameterize.js`

```js
projectPlanar(local)                          // area-weighted normal frame; writes local.uv
solveLSCM(local, { maxIter, tol } = {}) -> { ok, iterations, residual }   // Lévy 2002; two pins = farthest boundary pair; PCG on explicit normal equations (Jacobi)
tutteEmbed(local, { weights = 'meanvalue' | 'uniform' } = {}) -> boolean    // longest loop -> circle by arc length; Floater weights; PCG
countFlips(local) -> number
initChart(local, method: 'lscm' | 'tutte' | 'projection') -> { method, fallbacks: string[] }
    // lscm: projection -> LSCM -> if flips>0 -> Tutte (if that fails keep LSCM)
    // tutte: Tutte -> if it fails (no loops) -> LSCM
```
LSCM must be solved on **disk charts only** (engine guarantees). Non-disk
charts (fallback path) get `projectPlanar`.

### 4.7 `optimize.js`

```js
chartEnergy(local, energy = 'sd' | 'arap', frames?) -> number      // area-weighted mean, sd: (s1²+s2²+s1⁻²+s2⁻²)/4, 1.0 = isometric
buildRestFrames(local) -> { triArea: Float64Array(T), gx: Float64Array(3T), gy: Float64Array(3T) }
    // gradient coefficients: J = [[Σ gx_k u_k, Σ gy_k u_k], [Σ gx_k v_k, Σ gy_k v_k]] for k in tri corners
optimizeChart(local, {
    energy = 'sd', iterations = 12, tol = 1e-6,
    globalSolve = 'pcg' | 'jacobi',   // 'pcg' = real SLIM/ARAP global step; 'jacobi' = v3-style averaging (fast, weak)
    anderson = 0                      // Anderson acceleration depth m (0 = off)
  }, progress?) -> { energyBefore, energyAfter, iterations, flips, converged }
```
SLIM (Rabinovich et al. 2017): local step per triangle: `J = D X`, signed SVD,
closest rotation `R`, weights `w_i = sqrt((s_i - s_i^-3)/(s_i - 1))` (limit 2
at s=1 → w²=4) with `W = U diag(w1,w2) U^T`; global step minimises
`Σ_t area_t ‖W_t (J_t - R_t)‖_F²` — a 2n×2n SPD system assembled from the
per-triangle gradient coefficients (for ARAP, `W = I`). One vertex is pinned to
remove the translation null-space. Step direction `d = x* - x`; step length
`α = min(1, 0.9 α_flipfree)` followed by Armijo backtracking on the true
symmetric Dirichlet energy. A triangle with `s2 <= 0` (flipped at entry) uses a
large weight to be pushed out. Optimisation runs on **rest-scale UVs**: before
optimising, the chart is rescaled so that Σ UV area = Σ 3D area (which is the
minimiser of the SD energy w.r.t. global scale), so a repack never has to be
"undone".

### 4.8 `pack.js`

```js
packCharts(charts: Array<{ local: Local, area3D }>, {
    method = 'bitmap' | 'skyline',
    resolution = 1024,          // packing grid cells across the atlas
    paddingTexels = 4,          // dilation in cells (at packing resolution)
    rotations = 4,              // 1 (none), 2 (0/90), 4 (0/90/180/270), 8, 16
    equalizeDensity = true,     // scale each chart so UV area ∝ 3D area
    bruteForce = false          // bitmap: scan all positions vs. skyline-guided candidates
  }, progress?) -> {
    packedUV: Float32Array[]    // per chart, length 2n, in [0,1]
    rects: {x,y,w,h}[]          // atlas-space bounding boxes
    transforms: {scale, rotation, tx, ty}[],   // maps local.uv -> packed
    efficiency,                 // covered cells / atlas cells (from the pack bitmap)
    atlasCells                  // final atlas size in cells (square)
  }
```
Bitmap packing (xatlas-style): charts are sorted by area descending; each chart
is rasterised (conservatively, with padding dilation) into a bit image at the
packing resolution for each candidate rotation; the atlas is a growing square
bit image; candidate positions are tested with bit-parallel `AND` over
`Uint32` words (pre-shifted copies per 32 phase); the best position minimises
the atlas extent then `y` then `x`. If nothing fits, the atlas grows by 1/16
and the search continues. Final UVs are the placed cell coordinates divided by
the atlas size. **`local.uv` is never modified.** Skyline (v3) remains as the
fast fallback.

### 4.9 `metrics.js`

```js
computeMetrics(mesh, uv: Float32Array, faceChart: Int32Array, cut: Uint8Array | null, { rasterRes = 256, histogramBins = 32 } = {}) -> Metrics
Metrics {
  faces, vertices (corners), chartCount,
  stretchL2, stretchLinf,        // Sander 2001, normalised by global scale (1 = isometric)
  sdEnergy,                      // symmetric Dirichlet at global scale
  angleMeanDeg, angleMaxDeg,
  areaDistortionMean,            // mean |log(areaUV*scale² / area3D)|
  flipped, degenerate,
  seamLength3D, seamEdgeCount, seamSegments: Float32Array(6 * nSeamEdges),   // edges whose two faces are in different charts or are cut
  coverage, overlap,             // rasterised
  texelDensity: { mean, std, min, max, cvPercent },  // per-chart UV-area / 3D-area ratios (sqrt), relative to mean
  faceL2: Float32Array(F), faceAngleErr: Float32Array(F), faceAreaLog: Float32Array(F),
  histogram: { bins: Float32Array(histogramBins), edges: Float32Array(histogramBins+1) },   // of faceL2
  perChart: Array<{ id, faces, area3D, areaUV, stretchL2, flips, density }>,
  distortionMetric               // combined score (lower is better) – same formula family as v3
}
```
Seams come from **topology** (chart ids / cut flags), not from UV thresholds.

### 4.10 `projections.js`

```js
projectSpherical(mesh) / projectCylindrical(mesh) / projectPlanarWhole(mesh) -> { uv: Float32Array(6F), faceChart: Int32Array(F) (all 0) }
```

### 4.11 `engine.js`

```js
class UVEngine {
  setMesh(positions: Float32Array, { weldTolerance } = {}) -> MeshInfo   // { faceCount, weldCount, edgeCount, boundaryEdgeCount, nonManifoldEdgeCount, componentCount, eulerCharacteristic, surfaceArea, bbox }
  setCut(cut: Uint8Array | null)            // manual seams (length edgeCount)
  getCut() -> Uint8Array                    // includes auto cuts added by cutToDisk
  toggleSeamEdge(face, k) -> { edge, value }
  seamsFromAngle(deg) -> count              // marks edges with dihedral > deg
  clearSeams()
  edgeSegments(cut) -> Float32Array         // 6 floats per cut edge for drawing
  unwrap(opts, progress?, shouldCancel?) -> UnwrapResult
  relax(opts, progress?) -> UnwrapResult    // optimises rest-scale UVs of existing charts then repacks
  repack(opts, progress?) -> UnwrapResult
  optimizeSearch(opts, progress?) -> { best: UnwrapResult, trials: Array<{ params, score, metrics }> }
  metrics() -> Metrics
  snapshot() -> Snapshot                    // deep copy of uv + charts + cut (for undo)
  restore(snapshot)
}
UnwrapOpts = {
  mode: 'atlas' | 'box' | 'spherical' | 'cylindrical' | 'planar',
  parameterizer: 'lscm' | 'tutte' | 'projection',
  optimizer: 'slim' | 'arap' | 'none', iterations: 12, globalSolve: 'pcg',
  segmentation: { angleDeg, maxFaces, maxCost, weights, lloydIterations, mergeSmallCharts, minChartFaces },
  packing: { method, resolution, paddingTexels, rotations, equalizeDensity }
}
UnwrapResult = {
  uv: Float32Array(6F), faceChart: Int32Array(F),
  charts: Array<{ id, faces, nVerts, area3D, rect, isDisk, initMethod, fallbacks, energyBefore, energyAfter, flips }>,
  cut: Uint8Array(E), notes: string[], timings: { segment, topology, flatten, optimize, pack, metrics, total },
  metrics: Metrics
}
```
Stages report progress as `('segment'|'topology'|'flatten'|'optimize'|'pack'|'metrics', done, total)`.

### 4.12 `worker-main.js` and `client/engine-client.js`

Worker protocol (JSON-able messages, typed arrays transferred):
```
main -> worker : { id, op: 'setMesh'|'setCut'|'toggleSeamEdge'|'seamsFromAngle'|'clearSeams'|'unwrap'|'relax'|'repack'|'optimizeSearch'|'metrics'|'snapshot'|'restore', args }
worker -> main : { id, type: 'progress', stage, done, total } | { id, type: 'result', result } | { id, type: 'error', message, stack }
```
`EngineClient` exposes the same method names returning Promises, an
`onProgress(fn)` hook, `cancel()` (terminates and respawns the worker, then
re-sends the mesh and cut) and `.mode` (`'worker' | 'main'`). Worker creation:
`new Worker(URL.createObjectURL(new Blob([UVCore.source() + bootstrapText])))`;
on any failure fall back to running `UVEngine` directly on the main thread
(yielding to the event loop between stages with `setTimeout(0)` is NOT possible
inside synchronous kernels, so the fallback simply blocks — acceptable).

## 5. UI contracts (Three.js side)

* `io/loaders.js`: `loadFileToPositions(file: File) -> Promise<{ positions: Float32Array, name, sourceFormat, meshCount }>` (OBJ, GLTF, GLB, STL, PLY; merges all meshes; applies world transforms; non-indexed).
* `io/exporters.js`: `exportOBJ(mesh, name)`, `exportGLB(mesh, name)`, `exportUVPNG(uv, faceChart, metrics, { size, style: 'wire' | 'chart' | 'heat' | 'checker' })`, `exportReport(state)`, `saveProject(state) / loadProject(json)`.
* `ui/uv-view.js`: `class UVView { constructor(canvas) setData({ uv, faceChart, charts, metrics, cut }) setStyle({ mode: 'chart' | 'heat' | 'angle' | 'area' | 'none' }) on('hover'|'select', fn) select(chartId) resetView() }` with wheel zoom, drag pan, double-click reset, chart hit-test by point-in-triangle.
* `ui/seam-tool.js`: `class SeamTool { constructor(app) enable(bool) }` — pointer down on the 3D mesh raycasts, finds the closest edge of the hit face (distance from hit point to each edge segment), calls `engine.toggleSeamEdge(face, k)`, updates the seam overlay; Shift = remove only; Alt = add only.
* `ui/app.js` `UVToolkit`: owns renderer/scene/camera, `setModel(positions, name)`, `applyResult(UnwrapResult)`, overlays (`seamLines`, `cutLines`, `selectedChart` highlight via vertex colors), textures (`checker`, `colorGrid`), `runUnwrap()/runRelax()/runRepack()/runOptimize()` (async, disable buttons, progress), undo/redo via engine snapshots.

## 6. Test plan (tests/*.test.js)

* `math`: svd2 vs. brute force on random matrices (including reflections); heap ordering; union-find.
* `solvers`: PCG solves random SPD systems to 1e-8; block2 preconditioner equals jacobi on diagonal blocks.
* `mesh`: welding a cube soup gives 8 vertices / 18 edges / 12 faces (χ=2); boundary edges of an open grid; non-manifold edge count of a fan of 3 faces.
* `segmentation`: cube → 6 charts with box; sphere with 60° → charts are connected and never cross cut edges; all faces assigned.
* `chart`: annulus (grid with hole) → loops=2, not disk → cutToDisk adds one path and yields isDisk; closed sphere → bisected into disks; pinch vertex boundary tracing.
* `parameterize`: LSCM on a planar patch recovers the patch up to similarity (angle error < 1e-6); Tutte on a disk gives 0 flips; initChart fallbacks.
* `optimize`: SLIM lowers SD energy monotonically from a Tutte start on a hemisphere, ends with 0 flips; ARAP likewise; rest-scale invariance (optimising a chart scaled by 10 gives the same energy).
* `pack`: no two chart bitmaps overlap; all UVs in [0,1]; efficiency ≥ skyline's on the sphere fixture; rotations=1 never rotates.
* `metrics`: isometric map → L2 = 1, SD = 1, angle 0; a known 2× stretch gives L2 = √((4+1)/2)/scale…; flipped triangle counted; overlap detected for two identical charts.
* `engine`: full unwrap of a sphere/torus fixture: 0 flips, 0 overlap, all charts isDisk, coverage > 0.5; relax after pack does NOT explode (L2 stays < 1.5); snapshot/restore round-trip; source() round-trip build works.

## 7. Fixtures (`tests/fixtures.js`)

Pure-JS generators returning non-indexed `Float32Array` positions:
`gridPatch(nx, ny)`, `annulusPatch(nx, ny)` (grid with a hole), `uvSphere(segW, segH)`, `cube()`, `torusKnot(p=2,q=3, tubular=160, radial=24)` (matches THREE.TorusKnotGeometry), `cylinderOpen(seg)`.
