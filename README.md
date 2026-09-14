# UV Toolkit v4 — Browser UV Unwrapping Laboratory

A no-install, no-build UV unwrapping and UV-quality lab that runs entirely in the browser (it even works when you open `index.html` straight from disk). Load a model, get a production-style UV atlas, see exactly how good it is on a calibrated 0–100 score, fix what the tool tells you to fix, and export the model with its new UVs — and, if it was textured, with its texture re-baked onto the new layout.

v4 is a ground-up rewrite of the v3 single-file app around a tested geometry kernel built from current research (Boundary First Flattening, SLIM, xatlas/Blender-style bitmap packing, Seamster-style visibility-aware seams). The previous version is kept at [`legacy/index-v3.html`](legacy/index-v3.html) for comparison.

---

## What's new compared with v3

| | v3 | v4 |
|---|---|---|
| Flattening | LSCM with Tutte fallback | **Boundary First Flattening** (Sawhney & Crane 2017) → LSCM → mean-value Tutte fallbacks |
| Optimisation | Jacobi averaging approximation of SLIM | **Real SLIM** with sparse PCG global solve, flip-free line search and Anderson acceleration |
| Topology | Bisect closed charts | **Cut-to-disk**: shortest seam paths for holes, bisection for closed / high-genus charts, **automatic split of charts whose flattened boundary overlaps itself** |
| Segmentation | Normal-deviation flood fill | **xatlas-style simultaneous chart growth** with Lloyd refinement, plus optional **visibility-aware seams** |
| Packing | Skyline rectangles (~22% coverage on the torus knot) | **Bitmap packing** that nests shapes, rotations, scale search (~42–46% chart coverage, 0 overlaps verified) |
| Quality | Loose "distortion metric" | **Calibrated 0–100 score** with per-target curves, hard gates and "how to improve" actions; exact overlap tests; texel density in px/unit; texture use & equivalent resolution; bake-readiness checklist |
| Formats | OBJ in / OBJ out | **OBJ (+MTL), glTF, GLB, STL, PLY** in; **GLB (with texture), OBJ+MTL, UV PNG, UV-space maps, JSON report, ZIP bundle, project files** out |
| Textures | – | **GPU re-bake** of the original texture onto the new UVs; UV-space position / normal / chart-ID / mask maps for AI texturing |
| Editing | – | **Seam tool** (click edges in 3D), hard-edge seams, **reuse imported seams**, undo / redo, **A/B compare**, auto-tune, benchmark |
| Responsiveness | Main thread | **Web Worker** engine with progress and cancel (main-thread fallback) |
| Tests | – | **~130 node tests** covering every kernel module, IO and the worker protocol |

Measured on the default torus knot (7,680 triangles): L2 stretch **1.0048 → 1.0003**, symmetric Dirichlet **1.0067 → 1.0005**, atlas coverage **22% → 42–46%**, zero flips and zero overlaps in both.

---

## Quick start

```bash
git clone https://github.com/kai9987kai/Autounwrapping.git
cd Autounwrapping
```

Then either open `index.html` directly in Chrome, Edge or Firefox, or serve the folder:

```bash
npm run serve
```

and visit <http://localhost:8000>. No dependencies are installed; Node ≥ 20 is only needed for the dev server and the tests. The folder can be published as-is on GitHub Pages.

1. **Open** or drag in a model (or pick one from **Examples** — try *Textured sphere* to see texture re-baking).
2. Choose a **Target**: Game hero, Game prop, Lightmap, Film / VFX or Fast preview.
3. Press **▶ Unwrap** (`U`). Watch the score and follow **How to improve** — every suggestion has a **Fix** button.
4. **Export** a GLB / OBJ, the UV layout, maps, a report or everything as a ZIP.

---

## Features

### Unwrapping pipeline
- **Methods:** Atlas (segment → flatten → pack), Box charts for hard-surface models, Pelt (one chart per part, fewest seams), and spherical / cylindrical / planar projections for comparison.
- **Flattening:** Boundary First Flattening (default), LSCM, mean-value Tutte (always injective), planar projection.
- **Optimisation:** SLIM (symmetric Dirichlet) or ARAP, with a flip-blocking line search so results never fold.
- **Seams:** chart angle, maximum chart size, refinement rounds; cut every edge sharper than an angle; hide seams in occluded areas (visibility field rendered from 48 directions); click-to-cut seam tool; reuse the seams of imported UVs.
- **Packing:** bitmap packer with 90° rotations, texel-density equalisation, padding in texels (mip-safe to `log2(padding)`), texture sizes from 256 to 4096; skyline rectangles as a fast alternative.
- **Relax / Repack / Auto-tune:** refine existing charts, re-run packing alone, or search neighbouring chart angles and keep the best-scoring valid result.

### Quality analysis
- **UV quality score (0–100)** per target, built from stretch, angle and area distortion, texel-density evenness, texture use, seam length and fragmentation. Flips, overlaps or out-of-range UVs cap the score at 49; padding that is not mip-safe caps it at 89.
- **Metrics:** Sander L2 / L∞ stretch, symmetric Dirichlet (mean, p99, chart-optimal), angle and area error, flipped and degenerate faces, exact chart-overlap / self-intersection / containment tests, raster overlap texels, texel density (px/unit, CV), texture use, equivalent resolution, seam and visible-seam length.
- **Views:** 3D checker / colour grid / chart colours / original / baked textures; heat overlays for stretch, area, angle, texel density, flips and visibility; UV editor with zoom, pan, chart hover & selection, texel grid and baked-texture background; chart inspector; history and stretch histogram charts.
- **Grade imported UVs** with the same metrics and pin them next to generated layouts in **Compare**.

### Textures and export
- **Re-bake texture:** renders each triangle at its new UV position on the GPU while sampling the original texture at its old UVs (2× supersampled), then fills gutters with pull-push so mip-maps never bleed.
- **UV-space maps:** object-space position, normal, chart-ID and coverage mask at 1K / 2K / 4K for texturing and AI-texturing pipelines.
- **Export:** GLB (with baked texture), OBJ + MTL (+ texture), UV layout PNG, JSON quality report with methods and citations, ZIP bundle, and project files that restore mesh, UVs, seams and settings.

### Workflow
Undo / redo, A/B compare with deltas and restore, benchmark over the built-in models (CSV), settings persistence, light / dark themes, keyboard shortcuts and searchable in-app help.

| Key | Action | Key | Action |
|---|---|---|---|
| `O` | Open | `S` | Seam tool |
| `U` | Unwrap | `F` | Frame model |
| `R` | Relax | `W` | Wireframe |
| `P` | Repack | `1` `2` `3` | 3D / split / UV layout |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo | `Esc` | Cancel |
| `?` | Help | | |

---

## Benchmarks

Node 24, default Game-hero settings with a 1024 atlas and 4-texel padding:

| Model | Charts | Score | L2 stretch | Sym. Dirichlet | Flips | Valid | Chart coverage | Time |
|---|---|---|---|---|---|---|---|---|
| Torus knot (7.7k) | 38 | 68 | 1.0003 | 1.0005 | 0 | yes | 41.9% | 2.5 s |
| UV sphere (3k) | 14 | 73 | 1.0018 | 1.0025 | 0 | yes | 42.6% | 1.0 s |
| Torus (6.4k) | 17 | 73 | 1.0001 | 1.0002 | 0 | yes | 46.2% | 2.0 s |
| Cube (12) | 6 | 80 | 1.0000 | 1.0000 | 0 | yes | 62.7% | 0.3 s |
| Hemisphere (0.8k) | 6 | 84 | 1.0005 | 1.0007 | 0 | yes | 55.5% | 0.6 s |
| Torus knot (30.7k) | 56 | 68 | 1.0003 | 1.0004 | 0 | yes | 37.4% | 10.2 s |

Use **Benchmark** in the app to reproduce this with your own settings.

---

## Project structure

```text
index.html              app shell (classic <script> tags, works from file://)
src/core/               pure-JS geometry kernel — no DOM, no three.js; runs in the worker and under node
  registry.js           module registry; UVCore.source() builds the worker from the modules' own text
  math.js solvers.js    closed-form 2x2 SVD, heaps, union-find; CSR, PCG, BiCGSTAB
  mesh.js               welding, edges, adjacency, components
  visibility.js         Seamster-style multi-view visibility field
  segmentation.js       xatlas-style chart growth with Lloyd refinement
  chart.js              chart-local topology, boundary loops, cut-to-disk
  parameterize.js       BFF, LSCM (cotan form, pins), mean-value Tutte
  optimize.js           SLIM / ARAP with sparse global solve, line search, Anderson acceleration
  pack.js               bitmap and skyline atlas packing
  metrics.js            distortion, exact bijectivity, calibrated score, texel density, efficiency
  projections.js        spherical / cylindrical / planar projections
  engine.js             UVEngine: pipeline orchestration, seams, relax, repack, search, undo snapshots
  worker-main.js        generic worker message loop
src/client/             EngineClient: Blob-URL worker with main-thread fallback, FIFO queue, cancel + replay
src/io/                 loaders (OBJ/MTL, glTF, GLB, STL, PLY) and exporters (GLB, OBJ, PNG, report, ZIP, projects)
src/gpu/baker.js        GPU texture re-bake and UV-space maps
src/ui/                 viewport, UV editor, panels, help, styles, app controller
tests/                  node --test suites (kernel, IO, worker protocol) + fixtures
docs/ARCHITECTURE.md    module contracts
docs/RESEARCH.md        research survey (83 findings with sources) behind the v4 design
legacy/index-v3.html    the previous single-file version
tools/serve.js          zero-dependency dev server
```

---

## Development

```bash
npm test          # node --test (about 20 s)
npm run serve     # http://localhost:8000
```

Kernel modules follow `UVCore.define(name, factory)` and may only use earlier modules' exports, so the exact same code runs on the main thread, inside the worker (rebuilt from `UVCore.source()`), and under node. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the contracts and [docs/RESEARCH.md](docs/RESEARCH.md) for the survey and the ideas queued for future versions (UDIM tiles, island stacking, pins and live unwrap, quad rectify, projected Newton).

---

## Limitations

- Large meshes (≥ 30k triangles) take several seconds; the worker keeps the UI responsive and **Cancel** always works.
- Visibility-aware seams are experimental: they reduce visible seam length on some models and have little effect on others.
- No UDIM multi-tile packing, island stacking or interactive island transforms yet.
- Textures are re-baked in 8-bit sRGB; tangent-space normal maps are resampled but not re-oriented for the new tangent frame.
- Spherical / cylindrical projections are for comparison and can overlap at their wrap seam.

---

## Research basis

Boundary First Flattening — Sawhney & Crane, *ACM TOG* 2017 · SLIM — Rabinovich, Poranne, Panozzo & Sorkine-Hornung, *ACM TOG* 2017 · Anderson acceleration for geometry optimisation — Peng et al., *ACM TOG* 2018 · LSCM — Lévy, Petitjean, Ray & Maillot, *SIGGRAPH* 2002 · Mean-value coordinates — Floater, *CAGD* 2003 · Seamster — Sheffer & Hart, *IEEE Visualization* 2002 · Texture mapping progressive meshes (stretch metric) — Sander, Snyder, Gortler & Hoppe, *SIGGRAPH* 2001 · xatlas (chart growth and bitmap packing) · Blender `uv_pack` · Lighthouse scoring curves (calibrated score). Details and further sources in [docs/RESEARCH.md](docs/RESEARCH.md).

---

## Privacy

Everything runs locally in your browser. Models are never uploaded; there is no account, server or telemetry.

## License

[MIT](LICENSE) © kai9987kai. Vendored libraries: three.js (MIT), Chart.js (MIT).
