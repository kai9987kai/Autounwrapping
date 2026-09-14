/* Help: searchable knowledge base + shortcuts. search() is DOM-free (node-testable). */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};

  const TOPICS = [
    { t: 'Quick start', k: 'start begin how use open unwrap export', b: 'Open or drop a model (OBJ, glTF, GLB, STL, PLY), pick a Target that matches where the texture will be used, press ▶ Unwrap (U), then follow the "How to improve" suggestions. Export a GLB or OBJ with the new UVs from the Export menu.' },
    { t: 'The UV quality score', k: 'score grade quality 100 calibrated lighthouse gate', b: 'A 0–100 score combining stretch, angle and area distortion, texel-density evenness, texture use, seam length and fragmentation. Each metric passes through a log-normal curve (90 at the "good" point, 50 at the typical point) weighted for the chosen Target. Hard problems cap the score: flipped triangles, overlaps or UVs outside 0–1 cap it at 49; padding that is not mip-safe caps it at 89.' },
    { t: 'Targets (presets)', k: 'preset target game hero prop lightmap film vfx fast', b: 'Game hero: high resolution, generous padding, low stretch. Game prop: balanced. Lightmap: no overlaps, even texel density, tiny textures, charts must never be sub-texel. Film / VFX: very low distortion and long seams tolerated. Fast preview skips optimisation for instant feedback.' },
    { t: 'Unwrap methods', k: 'mode atlas box pelt whole projection spherical cylindrical planar', b: 'Atlas segments the surface into nearly flat charts, flattens each and packs them — the best general choice. Box makes up to six axis-aligned chart groups (hard surface). Pelt keeps one chart per connected part and cuts only what topology requires (organic, fewest seams). Projections map the whole model at once and are mainly for comparison.' },
    { t: 'Boundary First Flattening (BFF)', k: 'bff flatten conformal sawhney crane boundary', b: 'The default flattening (Sawhney & Crane 2017). It first decides the chart boundary shape from the surface curvature, then fills the interior conformally. With the boundary scale fixed it gives the least area distortion among angle-preserving maps and is very fast. If it ever produces a flipped triangle the chart falls back to Tutte automatically.' },
    { t: 'LSCM and Tutte', k: 'lscm tutte levy floater mean value injective', b: 'LSCM (Lévy 2002) is the classic conformal flattening with two pinned vertices. Tutte / mean-value embedding (Floater 2003) pins the boundary to a circle and is guaranteed not to flip — ideal as a safe start for the optimiser, but more stretched on its own.' },
    { t: 'SLIM and ARAP optimisation', k: 'slim arap optimise optimizer symmetric dirichlet iterations relax', b: 'SLIM (Rabinovich et al. 2017) minimises symmetric Dirichlet energy: it penalises both stretching and compression and blows up before a triangle can flip, so results stay valid. Each iteration solves a sparse linear system, followed by a flip-blocking line search; Anderson acceleration speeds convergence. ARAP targets rigidity instead. Relax (R) runs more iterations on the current charts and repacks.' },
    { t: 'Chart angle and seams', k: 'angle chart seam segmentation max faces refinement lloyd', b: 'Chart angle is the maximum normal deviation inside a chart. Lower values create flatter charts (less stretch) at the cost of more seams; higher values create fewer, larger charts. Refinement rounds re-seed charts from their centres (Lloyd) for rounder, straighter boundaries.' },
    { t: 'Hiding seams (visibility)', k: 'visibility occluded hide seams seamster ambient', b: 'When enabled the model is rendered from many directions to estimate how visible each edge is (Seamster, Sheffer & Hart 2002). Seams then prefer occluded places such as undersides and inner corners. Use the Visibility overlay to see the field.' },
    { t: 'Manual seams (seam tool)', k: 'seam tool cut weld manual mark hard edges shift alt', b: 'Toggle ✂ Seams (S) and click near an edge in the 3D view to cut it; click again to weld. Shift forces remove, Alt forces add. "Mark hard edges" cuts every edge sharper than the chosen angle. Manual seams are always respected by every method; unwrap again after editing.' },
    { t: 'Imported UVs', k: 'imported original existing uv grade analyse seams source', b: 'If the file already has UVs you can grade them with the same metrics ("Grade imported UVs"), keep their seams ("Use imported seams") and let the toolkit re-flatten and repack, or view the model with its original texture.' },
    { t: 'Packing', k: 'pack packing bitmap skyline padding rotation texture size resolution', b: 'Bitmap packing rasterises every chart and nests shapes into each other\'s gaps (xatlas / Blender style), usually 10–25% denser than rectangles. Padding is in texels at the chosen texture size: a gutter of p texels survives mip levels up to log2(p). Rotations let charts turn in 90° steps. Repack (P) re-runs packing only.' },
    { t: 'Texel density', k: 'texel density px unit even equalise cv', b: 'Texel density is how many texels cover one model unit. "Equalise texel density" scales every chart so detail is even across the model; the Density CV metric shows the remaining variation (0% is perfect).' },
    { t: 'Texture use and equivalent resolution', k: 'efficiency texture use waste equivalent resolution coverage', b: 'Texture use multiplies how much of the square the charts cover by how much of that area is undistorted. Equivalent resolution is the size a perfect atlas would need to deliver the same usable detail — a quick way to compare layouts.' },
    { t: 'Re-baking textures', k: 'bake rebake transfer texture original baked gpu', b: 'For textured models, "Re-bake texture" renders each triangle at its new UV position on the GPU while sampling the original texture at the old UVs, so the model keeps its look with the new layout. Gutters are filled by pull-push so mip-maps do not bleed. Export as GLB to get the model and baked texture together.' },
    { t: 'UV-space maps for AI texturing', k: 'maps position normal id mask ai texturing export', b: 'Export → UV-space maps writes position, object-space normal, chart ID and coverage mask images at the bake size. Texture-generation tools use these as conditioning inputs; the position and normal maps are dilated so they are safe to sample at seams.' },
    { t: 'Overlays and heat maps', k: 'overlay heat stretch area angle density flips colours', b: 'Blue is good and red is bad. Stretch shows symmetric Dirichlet per face, Area shows relative size error, Angle shows shape distortion, Density shows texel density relative to the mean, Flips marks mirrored triangles. The UV editor has the same modes.' },
    { t: 'Auto-tune', k: 'auto tune search optimise settings best', b: 'Auto-tune tries neighbouring chart angles and keeps the result with the best score (valid layouts always win). It takes a few unwraps worth of time.' },
    { t: 'Compare results', k: 'compare pin ab table restore', b: 'Pin the current result, change settings, unwrap again and pin that too. The table highlights what got better (green) or worse (red) relative to the first pin, and ↺ restores any pinned result.' },
    { t: 'Undo, projects and export', k: 'undo redo project save load export glb obj zip bundle report', b: 'Undo / redo cover unwraps, relax, repack and seam edits. Save project stores the mesh, UVs, seams and settings in one file. Export offers GLB (with baked texture), OBJ + MTL, UV layout PNG, a JSON quality report, or everything as a ZIP.' },
    { t: 'Performance and large models', k: 'performance slow large worker cancel faces', b: 'The kernel runs in a background worker so the page stays responsive; press Cancel to stop. Very large meshes (hundreds of thousands of faces) take longer — use Fast preview while exploring, lower refinement rounds, or decimate the model first.' },
    { t: 'Troubleshooting', k: 'problem error flipped overlap non manifold broken', b: 'Flipped or overlapping charts: press Relax, or unwrap with Tutte flattening. Non-manifold or inconsistently wound edges are cut automatically (see the pipeline log). A model that loads without faces is probably a point cloud or lines-only file.' },
    { t: 'Keyboard shortcuts', k: 'keyboard shortcut keys hotkey', b: '<kbd>O</kbd> open · <kbd>U</kbd> unwrap · <kbd>R</kbd> relax · <kbd>P</kbd> repack · <kbd>S</kbd> seam tool · <kbd>F</kbd> frame · <kbd>W</kbd> wireframe · <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> layout · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Y</kbd> redo · <kbd>Esc</kbd> cancel / close · <kbd>?</kbd> help', html: true }
  ];

  function search(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return TOPICS.slice();
    const words = q.split(/\s+/);
    return TOPICS.map(t => {
      const hay = (t.t + ' ' + t.k + ' ' + t.b).toLowerCase();
      let score = 0;
      for (const w of words) {
        if (t.t.toLowerCase().includes(w)) score += 5;
        if (t.k.includes(w)) score += 3;
        if (hay.includes(w)) score += 1;
      }
      return { t, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.t);
  }

  function render(container, query) {
    const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const found = search(query);
    container.innerHTML = found.length ? found.map(t => '<article><h4>' + esc(t.t) + '</h4><p>' + (t.html ? t.b : esc(t.b)) + '</p></article>').join('') : '<p class="hint">No topic matches “' + esc(query) + '”.</p>';
  }

  UVApp.help = { topics: () => TOPICS.map(t => t.t), search, render };
})(typeof window !== 'undefined' ? window : globalThis);
