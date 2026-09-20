# UV Toolkit 4.1: editable layouts and accountable quality checks

Updated 20 September 2026. This note describes the implemented upgrade and the research that informed its priorities. The application remains a browser UV laboratory with a JavaScript geometry kernel, worker execution, and a single 0–1 atlas. It does not implement PartUV, TABI, or FastAtlas, and this release makes no measured performance claim against those systems.

## What changed

**Existing UVs can become the working layout.** Choose **Use imported layout** to retain the imported corner coordinates, build editable islands, and then relax or repack them. A seam can run inside a connected island: the adoption path preserves those corner splits, including differences smaller than the tolerance used to group analysis islands. Adoption does not certify the source UVs; collapsed, overlapping, or out-of-range layouts remain diagnosable. Padding remains unknown until packing establishes it.

**Individual charts can be edited.** Select a chart and apply a rotation, positive uniform scale, or U/V offset. The engine updates that chart and recomputes metrics; it reports newly introduced overlaps and out-of-range UVs. Edits participate in undo/redo. Repeated scale edits persist through repacking when density equalization is disabled; enabling equalization deliberately rebalances chart density. A manual edit invalidates the previous packing-margin evidence, so its padding returns to unknown.

**Mesh health accompanies each loaded model.** The preflight reports duplicate triangles, collapsed or weld-collapsed faces, thin triangles, inconsistent edge winding, non-manifold edges, boundaries, and connected parts. Open surfaces are supported. The topology checks run when preparing the mesh; their results appear when loading completes. They explain likely causes of poor results and suggest repairs; they do not automatically repair the model or certify that the mesh is suitable for every downstream use.

**Project and recovery state preserve more of the work.** New snapshots include local triangle connectivity and a geometry-sensitive mesh fingerprint. Validation rejects malformed chart ownership, coordinates, options, and seam data before replacing the current state. Older snapshot formats remain readable, including their weaker topology-only fingerprints. Project files retain supported diffuse material colours, source images, texture transforms, and sampler settings, subject to explicit input limits. Older projects without embedded materials disclose that limitation. Worker recovery keeps accepted mesh, source-UV, and seam state; rejected updates do not become replay state.

## Quality results now distinguish failure from missing evidence

`score.valid` is false for collapsed or non-finite faces, unassigned charts, flipped faces, detected overlaps, UVs outside the supported atlas range, empty meshes, and incomplete overlap validation. The metrics separately expose `geometryDegenerate`, `uvDegenerate`, and `nonFinite` counts. A low distortion average over the remaining usable faces cannot make an invalid layout valid.

Overlap checks now examine connected UV components even when multiple disconnected pieces share one chart label. This detects a small component contained inside another without requiring a raster sample to hit it. Coincident boundary segments running in the same direction identify overlapping positive-orientation interiors; legitimate shared boundaries running in opposite directions remain allowed. Raster overlap ownership is per face, so overlaps inside a single labelled chart are also counted.

These are bounded floating-point boundary, containment, orientation, and raster checks, not an all-purpose bijectivity proof. The boundary comparison budget is explicit: if exhausted, `bijectivity.complete` becomes false and validation fails. The engine's raster analysis uses at most 1024 × 1024 samples; zero raster overlaps alone cannot establish that no overlap exists. Tolerances, near-degenerate input, and unusual topology remain reasons to inspect the result in the intended downstream application.

The 0–100 score is a configurable heuristic combining distortion, density, texture use, seams, and fragmentation. Its curves and thresholds are engineering choices, not a perceptually validated rating or evidence of superiority to another unwrap method. `score.valid` describes the implemented layout checks; it does not mean the layout meets every baking or rendering requirement.

## Local texel density

The primary density coefficient of variation, `texelDensity.cv`, now measures variation between faces, weighted by their 3D area. For face `f`, density is proportional to `sqrt(abs(UV area_f) / 3D area_f)`, multiplied by the atlas resolution for pixels per model unit. This reveals density changes inside one island that an island-average comparison could hide.

`texelDensity.chartCV` retains the former comparison between chart-average densities, and `chartMean` retains that average. A single chart can therefore have `chartCV = 0` while its local `cv` is nonzero. Equalizing chart sizes can improve the former while leaving local distortion to be addressed by relaxation or better seams. Pixels per unit use the model's coordinate units; they are not automatically pixels per metre.

## Packing margins and the small-atlas fallback

Requested padding and effective padding are separate values. Packing on a coarser working grid rounds gutter sizes to working texels, then reports their size at the final atlas resolution. Quality analysis uses that final resolution and effective margin rather than assuming the requested settings were achieved.

When gutters alone cannot fit, repeatedly shrinking chart geometry can collapse its UV coordinates at Float32 precision. The new bounded fallback retries at a larger temporary atlas and uniformly rescales the whole layout to the requested size. It preserves useful chart area while reporting `packing.fits = false` and a reduced `packing.effectivePadding`. This is a recoverable layout with reduced margins, not success at the original padding request.

The bake evidence contract is:

| Field | Meaning |
| --- | --- |
| `paddingKnown` | Whether a finite nonnegative margin was supplied or established by the packer. |
| `paddingTexels` | Effective margin at the reported resolution; `null` when unknown. |
| `requestedPaddingTexels` | Requested setting, kept separately from the effective result. |
| `paddingSource` | `packer`, `provided`, or `unknown`; supplied evidence is not an independent margin measurement. |
| `maxSafeMip` | Historical field name for the estimate `floor(log2(paddingTexels))`, or `-1` below one texel or when unknown. |
| `ready` | The implemented layout checks pass, padding is known and meets the preset's estimated mip target, no chart is subtexel by area, and local density CV is at most 0.25. |

The mip estimate is not a filtering guarantee. Actual results also depend on the target renderer's filtering, anisotropy, compression, dilation, mip generation, and sampling near boundaries. Imported and manually moved layouts cannot pass the padding check simply because a padding value remains selected in the UI. Very thin charts can also need inspection even when their total area exceeds one texel.

## Recent research and the practical priorities it informed

The following connections are design inferences from the cited work. They do not imply that the toolkit reproduces the papers' algorithms, evaluations, or results.

| Source | Relevant idea | Relationship to this upgrade |
| --- | --- | --- |
| [PartUV: Part-Based UV Unwrapping of 3D Meshes](https://arxiv.org/abs/2511.16659), submitted November 2025 and revised 17 February 2026 | Combines learned part decomposition with recursive geometric processing to reduce fragmentation while controlling distortion; explicitly addresses difficult generated meshes. | Motivates preserving useful existing island structure and exposing input-mesh problems. This upgrade adds imported-layout adoption and diagnostics; it has no PartField model, learned semantic decomposition, or PartUV distortion-bound algorithm. |
| [TABI: Tight and Balanced Interactive Atlas Packing](https://www.cs.ubc.ca/labs/imager/tr/2026/tabi/), Eurographics 2026 | Uses GPU processing, shape approximations, compaction, and balancing to trade packing quality against interactive runtime. | Motivates treating packing quality, chart downscaling, and runtime as separate concerns. The toolkit retains its JavaScript bitmap/skyline packers; the small-atlas fallback is an implementation repair, not TABI compaction or a GPU port. |
| [FastAtlas: Real-Time Compact Atlases for Texture Space Shading](https://arxiv.org/abs/2502.17712), February 2025 | Computes GPU atlases for texture-space shading, including per-frame charting and parameterization with a controlled texel-to-pixel relationship. | Reinforces the value of local density measurements and explicit application context. This toolkit reports static mesh pixels per model unit; it does not perform view-dependent per-frame atlasing or texture-space shading. |
| [xatlas public API](https://github.com/jpcy/xatlas/blob/master/source/xatlas/xatlas.h) | Separates mesh/UV input, chart construction, and packing; exposes resolution, padding, texels per unit, bilinear margins, and rotation controls. | Provides a practical reference for treating imported layouts and repacking as separate workflows and for reporting packing settings precisely. The toolkit's existing xatlas-style heuristics are independent JavaScript implementations, not the xatlas library or API-equivalent behaviour. |

## Reproducible validation and remaining bounds

The regression suites exercise concrete invariants rather than relying on one attractive atlas:

- [Mesh tests](../tests/mesh.test.js) cover duplicate, thin, collapsed, inconsistently wound, and non-manifold fixtures, plus malformed input rejection.
- [Engine tests](../tests/engine.test.js) cover a cylinder with a wrap seam inside one connected UV island, tiny corner discontinuities, degenerate imported corners, adoption cancellation, isolated chart transforms, cumulative scale edits, foreign snapshots, and transactional failures.
- [Metrics tests](../tests/metrics.test.js) include hand-derived isometric and anisotropic distortion values; non-finite and collapsed UVs; nested components smaller than the raster sample spacing; duplicate faces; legal shared edges; local density variation in one chart; and unknown versus effective padding.
- [Packing tests](../tests/pack.test.js) exercise conservative overlap checks, gutter separation, rotation and transform consistency, ring-hole nesting, density equalization, preserved mirrored orientation, coarse-grid padding conversion, malformed inputs, and chart-area preservation in the small-atlas fallback.
- [Worker-client tests](../tests/engine-client.test.js) cover ordered calls, cancellation/restart, accepted-state replay, disposal, transferred buffers, and fallback after worker initialization failure. [Project/export tests](../tests/io-exporters.test.js) cover serialization, malformed project rejection, chart ownership, legacy projects, material metadata, and glTF UV orientation.

Run `npm test` for the Node suites and `npm run check` for the repository check. `npm run test:browser` provides the browser smoke workflow where its browser dependencies are available. Use the current command output for totals and timing; the fixtures' runtime ceilings are regression guards, not benchmarks against research systems or guarantees on every device.

Verified on Windows with Node 24.13.1 and headless Edge 154.0.4258.24 on 20 September 2026: all **165 Node tests**, JavaScript syntax checks, and **28 browser workflow checks** passed. Browser checks include exact UV adoption, numeric island edits, undo/redo, texture/material project roundtrip, rebaking, cancellation during snapshot and project reading, failed-load retention, direct `file://` startup, and no uncaught page errors. Desktop dark and compact light screenshots were inspected; narrow-pane framing and UV resize behavior have dedicated regression tests. The browser receipt and screenshots are generated in ignored `output/browser-qa/`; full check output was saved in `output/check.log`.

The existing BFF/LSCM/Tutte flattening, SLIM/ARAP relaxation, and heuristic packing pipeline remain. This release does not add learned semantic segmentation, UDIM packing, automatic island stacking, or general mesh repair. Texture handling covers the application's supported diffuse workflow; it does not reorient tangent-space normal maps for a changed tangent frame. Large or pathological inputs can still require repair, different segmentation settings, a larger atlas, or another specialized tool. The changes make more of those limitations observable and preserve more of an artist's existing work.
