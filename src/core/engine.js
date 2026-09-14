/* UVEngine: stateful orchestration of the unwrap pipeline.
 * Pure JS (worker + node safe). Contract: ARCHITECTURE.md §4.11.
 *
 * Every method may be called as method(...args, progress, shouldCancel) (the
 * worker appends both); optional arguments that are functions are treated as
 * those callbacks. Results own their buffers (fresh copies), so the worker can
 * transfer them without detaching the engine's state.
 */
UVCore.define('engine', function (C) {
  'use strict';

  const VERSION = '4.0.0';
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  const DEFAULTS = {
    mode: 'atlas',                 // 'atlas' | 'box' | 'whole' | 'spherical' | 'cylindrical' | 'planar'
    parameterizer: 'bff',          // 'bff' | 'lscm' | 'tutte' | 'projection'
    optimizer: 'slim',             // 'slim' | 'arap' | 'none'
    iterations: 12,
    anderson: 5,
    preset: 'game_hero',
    segmentation: { angleDeg: 50, maxFaces: 6000, maxCost: 2.0, lloydIterations: 3, mergeSmallCharts: true, minChartFaces: 3 },
    packing: { method: 'bitmap', resolution: 1024, paddingTexels: 4, bilinear: true, rotations: 4, orientToAxis: true, equalizeDensity: true, searchMs: 0 },
    seams: { visibility: false, views: 48, domain: 'sphere', sharpAngleDeg: 0 }
  };

  function merge(base, over) {
    const out = Object.assign({}, base);
    if (!over) return out;
    for (const k of Object.keys(over)) {
      const v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], v);
      else if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /* Splits (opts?, progress?, shouldCancel?) where the caller may omit opts. */
  function cb(args) {
    let i = 0;
    const opts = typeof args[0] === 'function' ? (i = 0, undefined) : (i = 1, args[0]);
    const progress = typeof args[i] === 'function' ? args[i] : null;
    const shouldCancel = typeof args[i + 1] === 'function' ? args[i + 1] : null;
    return { opts, progress, shouldCancel };
  }

  class UVEngine {
    constructor() {
      this.mesh = null;
      this.manualCut = null;
      this.lastCut = null;
      this.sourceUV = null;
      this.state = null;      // { opts, charts, uv, faceChart, cut, packing, notes, timings, metricsSummary }
      this.visCache = null;
    }

    version() { return VERSION; }
    defaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }
    capabilities() {
      return {
        version: VERSION,
        modes: ['atlas', 'box', 'whole', 'spherical', 'cylindrical', 'planar'],
        parameterizers: ['bff', 'lscm', 'tutte', 'projection'],
        optimizers: ['slim', 'arap', 'none'],
        packMethods: ['bitmap', 'skyline'],
        presets: Object.keys(C.PRESETS).filter(k => k !== 'vfx'),
        visibility: typeof C.computeVisibility === 'function'
      };
    }

    /* ---------------- mesh & seams ---------------- */
    setMesh(positions, options) {
      const opts = typeof options === 'function' ? {} : (options || {});
      if (!(positions instanceof Float32Array)) positions = new Float32Array(positions);
      this.mesh = C.buildMesh(positions, { weldTolerance: opts.weldTolerance });
      this.manualCut = new Uint8Array(this.mesh.edgeCount);
      this.lastCut = new Uint8Array(this.mesh.edgeCount);
      this.sourceUV = null;
      this.state = null;
      this.visCache = null;
      return this.meshInfo();
    }

    meshInfo() {
      const m = this.requireMesh();
      return {
        faceCount: m.faceCount, weldCount: m.weldCount, edgeCount: m.edgeCount,
        boundaryEdgeCount: m.boundaryEdgeCount, nonManifoldEdgeCount: m.nonManifoldEdgeCount,
        componentCount: m.componentCount, eulerCharacteristic: m.eulerCharacteristic,
        surfaceArea: m.surfaceArea, bbox: { min: m.bbox.min.slice(), max: m.bbox.max.slice() },
        weldTolerance: m.weldTolerance
      };
    }

    requireMesh() {
      if (!this.mesh) throw new Error('No mesh loaded (call setMesh first).');
      return this.mesh;
    }

    setCut(cut) {
      const m = this.requireMesh();
      this.manualCut = new Uint8Array(m.edgeCount);
      if (cut && typeof cut !== 'function') {
        if (cut.length !== m.edgeCount) throw new Error('setCut: expected ' + m.edgeCount + ' edge flags, got ' + cut.length);
        for (let e = 0; e < m.edgeCount; e++) this.manualCut[e] = cut[e] ? 1 : 0;
      }
      return this.countSeams();
    }
    getCut() { this.requireMesh(); return Uint8Array.from(this.lastCut); }
    getManualCut() { this.requireMesh(); return Uint8Array.from(this.manualCut); }
    countSeams() { let n = 0; for (let e = 0; e < this.manualCut.length; e++) n += this.manualCut[e]; return n; }

    toggleSeamEdge(face, k, value) {
      const m = this.requireMesh();
      if (!(face >= 0 && face < m.faceCount) || !(k >= 0 && k < 3)) return { edge: -1, value: 0 };
      const e = m.faceEdges[3 * face + k];
      if (e < 0) return { edge: -1, value: 0 };
      this.manualCut[e] = typeof value === 'number' ? (value ? 1 : 0) : (this.manualCut[e] ? 0 : 1);
      return { edge: e, value: this.manualCut[e] };
    }

    setSeamEdges(edges, value) {
      const m = this.requireMesh();
      let changed = 0;
      for (const e of edges) if (e >= 0 && e < m.edgeCount && this.manualCut[e] !== (value ? 1 : 0)) { this.manualCut[e] = value ? 1 : 0; changed++; }
      return changed;
    }

    seamsFromAngle(deg) {
      const m = this.requireMesh();
      const cosT = Math.cos((typeof deg === 'number' ? deg : 60) * Math.PI / 180);
      let n = 0;
      for (let e = 0; e < m.edgeCount; e++) {
        if (C.faceDihedralCos(m, e) < cosT && !this.manualCut[e]) { this.manualCut[e] = 1; n++; }
      }
      return n;
    }

    clearSeams() { this.requireMesh(); this.manualCut.fill(0); return 0; }

    edgeSegments(which) {
      const m = this.requireMesh();
      const w = typeof which === 'string' ? which : 'manual';
      if (w === 'all') return C.edgeSegments(m, this.lastCut);
      if (w === 'seams' && this.state) return C.edgeSegments(m, this.state.seamFlags);
      return C.edgeSegments(m, this.manualCut);
    }

    /* ---------------- imported UVs ---------------- */
    setSourceUV(uv) {
      const m = this.requireMesh();
      if (!uv || typeof uv === 'function') { this.sourceUV = null; return null; }
      if (uv.length !== 6 * m.faceCount) throw new Error('setSourceUV: expected ' + (6 * m.faceCount) + ' values, got ' + uv.length);
      this.sourceUV = Float32Array.from(uv);
      return C.islandsFromUV(m, this.sourceUV).chartCount;
    }

    analyzeSource(...args) {
      const { opts } = cb(args);
      const m = this.requireMesh();
      if (!this.sourceUV) throw new Error('The model has no imported UVs to analyse.');
      const o = merge(DEFAULTS, opts);
      return C.computeMetrics(m, this.sourceUV, null, null, { preset: o.preset, resolution: o.packing.resolution, paddingTexels: o.packing.paddingTexels, rasterRes: Math.min(1024, o.packing.resolution) });
    }

    /* Imported UV discontinuities become manual seams (artist seams are kept). */
    seamsFromSourceUV() {
      const m = this.requireMesh();
      if (!this.sourceUV) throw new Error('The model has no imported UVs.');
      const isl = C.islandsFromUV(m, this.sourceUV);
      const probe = C.computeMetrics(m, this.sourceUV, isl.faceChart, null, { rasterRes: 16 });
      let n = 0;
      // seamSegments come from seam flags; recompute the flags cheaply
      for (let e = 0; e < m.edgeCount; e++) {
        const s = m.edgeFaceStart[e], cnt = m.edgeFaceStart[e + 1] - s;
        if (cnt < 2) continue;
        const f0 = m.edgeFaceList[s];
        for (let i = 1; i < cnt; i++) {
          if (isl.faceChart[m.edgeFaceList[s + i]] !== isl.faceChart[f0]) { if (!this.manualCut[e]) { this.manualCut[e] = 1; n++; } break; }
        }
      }
      return { added: n, islands: isl.chartCount, seamEdges: probe.seamEdgeCount };
    }

    /* ---------------- pipeline ---------------- */
    unwrap(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const m = this.requireMesh();
      const o = merge(DEFAULTS, opts);
      const t0 = now(), timings = { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 };
      const notes = [];
      const cancelled = () => !!(shouldCancel && shouldCancel());
      const F = m.faceCount;
      const cut = Uint8Array.from(this.manualCut);

      if (o.mode === 'spherical' || o.mode === 'cylindrical' || o.mode === 'planar') {
        const proj = o.mode === 'spherical' ? C.projectSpherical(m) : o.mode === 'cylindrical' ? C.projectCylindrical(m) : C.projectPlanarWhole(m);
        notes.push('Single-chart ' + o.mode + ' projection: relax and repack need an atlas / box / whole unwrap.');
        this.lastCut = cut;
        this.state = { opts: o, charts: [], uv: proj.uv, faceChart: proj.faceChart, cut, packing: null, notes, timings, projection: true };
        return this.finish(timings, t0, progress);
      }

      // ---- seams weights (visibility-aware)
      let edgeWeight = null, edgeSeamCost = null;
      if (o.seams && o.seams.visibility && typeof C.computeVisibility === 'function') {
        const key = o.seams.views + '|' + o.seams.domain;
        if (!this.visCache || this.visCache.key !== key) {
          if (progress) progress('visibility', 0, 1);
          this.visCache = { key, vis: C.computeVisibility(m, { views: o.seams.views, domain: o.seams.domain }) };
        }
        const ev = this.visCache.vis.edgeVis;
        edgeWeight = new Float32Array(m.edgeCount);
        edgeSeamCost = new Float32Array(m.edgeCount);
        for (let e = 0; e < m.edgeCount; e++) { edgeWeight[e] = ev[e] + 0.02; edgeSeamCost[e] = Math.max(0, 1 - 2 * ev[e]); }
        notes.push('Visibility-aware seams (' + o.seams.views + ' views).');
      }

      // ---- segmentation
      let t = now();
      if (progress) progress('segment', 0, 1);
      let seg;
      if (o.mode === 'box') seg = C.segmentByAxis(m, cut);
      else if (o.mode === 'whole') seg = C.segmentWhole(m, cut);
      else {
        const sOpts = Object.assign({}, o.segmentation, { shouldCancel });
        if (edgeSeamCost) { sOpts.edgeSeamCost = edgeSeamCost; sOpts.weights = Object.assign({ seam: 2 }, sOpts.weights || {}); }
        if (o.seams && o.seams.sharpAngleDeg > 0) { sOpts.sharpAngleDeg = o.seams.sharpAngleDeg; sOpts.weights = Object.assign({}, sOpts.weights || {}, { sharp: 4 }); }
        seg = C.segmentCharts(m, sOpts, cut, progress);
      }
      if (!seg || seg.cancelled) return { cancelled: true };
      timings.segment = now() - t;
      if (progress) progress('segment', 1, 1);

      // ---- topology: every chart becomes one or more disks
      t = now();
      const pieces = [], locals = [];
      let splits = 0, cutsAdded = 0, sanitized = 0;
      for (let i = 0; i < seg.chartFaces.length; i++) {
        if (cancelled()) return { cancelled: true };
        const faces = seg.chartFaces[i];
        if (!faces.length) continue;
        const r = C.cutToDisk(m, faces, cut, { edgeWeight });
        splits += r.splits; cutsAdded += r.cutsAdded; sanitized += r.sanitizedEdges;
        for (let j = 0; j < r.pieces.length; j++) { pieces.push(r.pieces[j]); locals.push(r.locals[j]); }
        if (progress && (i & 15) === 0) progress('topology', i, seg.chartFaces.length);
      }
      if (splits) notes.push('Split ' + splits + ' closed or high-genus chart(s) into disks.');
      if (cutsAdded) notes.push('Added ' + cutsAdded + ' seam edge(s) to open annular charts.');
      if (sanitized) notes.push('Treated ' + sanitized + ' non-manifold / inconsistently wound edge(s) as seams.');
      timings.topology = now() - t;

      // ---- flatten + optimise; charts whose boundary folds over itself are split and redone
      const charts = [];
      let tF = 0, tO = 0, fallbacks = 0, remainingFlips = 0, overlapSplits = 0;
      const work = locals.map(l => ({ local: l, depth: 0 }));
      const total0 = work.length;
      for (let wi = 0; wi < work.length; wi++) {
        if (cancelled()) return { cancelled: true };
        const { local, depth } = work[wi];
        let s = now();
        const init = C.initChart(local, local.euler.isDisk ? o.parameterizer : 'projection');
        tF += now() - s;
        s = now();
        let opt = null;
        if (o.optimizer !== 'none' && o.iterations > 0 && local.faces.length >= 2) {
          opt = C.optimizeChart(local, { energy: o.optimizer === 'arap' ? 'arap' : 'sd', iterations: o.iterations, anderson: o.anderson, shouldCancel });
        }
        tO += now() - s;
        const flips = C.countFlips(local);
        if (local.euler.isDisk && depth < 6 && local.faces.length >= 8 && C.chartBoundarySelfIntersects(local)) {
          const [A, B] = C.bisectFaces(m, local.faces, cut);
          if (A.length && B.length) {
            overlapSplits++;
            for (const half of [A, B]) {
              const r = C.cutToDisk(m, half, cut, { edgeWeight, maxSplits: 8 });
              for (const l of r.locals) work.push({ local: l, depth: depth + 1 });
            }
            continue;
          }
        }
        if (init.fallbacks.length) fallbacks++;
        remainingFlips += flips;
        charts.push({ faces: local.faces, local, init, opt, flips });
        if (progress && (wi & 7) === 0) progress('flatten', Math.min(wi, total0), Math.max(total0, work.length));
      }
      timings.flatten = tF; timings.optimize = tO;
      if (overlapSplits) notes.push('Split ' + overlapSplits + ' chart(s) whose flattened boundary overlapped itself.');
      if (fallbacks) notes.push(fallbacks + ' chart(s) used a fallback flattening method.');
      if (remainingFlips) notes.push(remainingFlips + ' flipped triangle(s) remain (non-disk charts fell back to projection).');

      this.lastCut = cut;
      this.state = { opts: o, charts, uv: null, faceChart: null, cut, packing: null, notes, timings };
      this.packState(o, progress);
      return this.finish(timings, t0, progress);
    }

    packState(o, progress) {
      const m = this.mesh, st = this.state;
      const t = now();
      const res = C.packCharts(st.charts.map(c => ({ local: c.local, area3D: c.local.area3D })), o.packing, progress);
      const uv = new Float32Array(6 * m.faceCount), faceChart = new Int32Array(m.faceCount).fill(-1);
      for (let ci = 0; ci < st.charts.length; ci++) {
        const { local } = st.charts[ci], puv = res.packedUV[ci];
        for (let tt = 0; tt < local.faces.length; tt++) {
          const f = local.faces[tt];
          faceChart[f] = ci;
          for (let k = 0; k < 3; k++) {
            const v = local.tris[3 * tt + k], c = 3 * f + k;
            uv[2 * c] = puv[2 * v]; uv[2 * c + 1] = puv[2 * v + 1];
          }
        }
        st.charts[ci].rect = res.rects[ci];
        st.charts[ci].transform = res.transforms[ci];
      }
      st.uv = uv; st.faceChart = faceChart;
      st.packing = { method: o.packing.method, coverage: res.coverage, chartCoverage: res.chartCoverage, efficiency: res.efficiency, texelsPerUnit: res.texelsPerUnit, resolution: res.resolution, extent: res.extent, overlapTexels: res.overlapTexels, mirroredCharts: res.mirroredCharts, restarts: res.restarts };
      if (res.mirroredCharts.length) st.notes.push(res.mirroredCharts.length + ' mirrored chart(s) packed as-is.');
      st.timings.pack = now() - t;
    }

    finish(timings, t0, progress) {
      const m = this.mesh, st = this.state, o = st.opts;
      const t = now();
      if (progress) progress('metrics', 0, 1);
      const metrics = C.computeMetrics(m, st.uv, st.faceChart, st.cut, {
        preset: o.preset, resolution: o.packing.resolution, paddingTexels: st.packing ? o.packing.paddingTexels : undefined,
        rasterRes: Math.min(1024, o.packing.resolution),
        edgeVis: this.visCache && o.seams && o.seams.visibility ? this.visCache.vis.edgeVis : undefined
      });
      // seam flags for overlays
      st.seamFlags = new Uint8Array(m.edgeCount);
      for (let e = 0; e < m.edgeCount; e++) {
        const s = m.edgeFaceStart[e], n = m.edgeFaceStart[e + 1] - s;
        if (n < 2) continue;
        if (st.cut[e]) { st.seamFlags[e] = 1; continue; }
        const f0 = m.edgeFaceList[s];
        for (let i = 1; i < n; i++) if (st.faceChart[m.edgeFaceList[s + i]] !== st.faceChart[f0]) { st.seamFlags[e] = 1; break; }
      }
      timings.metrics = now() - t;
      timings.total = now() - t0;
      if (progress) progress('metrics', 1, 1);
      st.metricsScore = metrics.score.score;
      return this.result(metrics);
    }

    result(metrics) {
      const st = this.state;
      return {
        uv: Float32Array.from(st.uv), faceChart: Int32Array.from(st.faceChart),
        charts: st.charts.map((c, id) => ({
          id, faces: c.faces.length, nVerts: c.local.nVerts, area3D: c.local.area3D,
          areaUV: metrics.perChart[id] ? metrics.perChart[id].areaUV : 0, rect: c.rect || null,
          isDisk: c.local.euler.isDisk, initMethod: c.init.method, fallbacks: c.init.fallbacks.slice(),
          energyBefore: c.opt ? c.opt.energyBefore : null, energyAfter: c.opt ? c.opt.energyAfter : null, flips: c.flips
        })),
        cut: Uint8Array.from(st.cut), manualCut: Uint8Array.from(this.manualCut),
        seamSegments: metrics.seamSegments,
        notes: st.notes.slice(), timings: Object.assign({}, st.timings),
        metrics, packing: st.packing ? Object.assign({}, st.packing) : null,
        opts: JSON.parse(JSON.stringify(st.opts)), projection: !!st.projection
      };
    }

    requireCharts(what) {
      if (!this.state || !this.state.charts.length) throw new Error(what + ' needs an atlas, box or whole unwrap first.');
      return this.state;
    }

    relax(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const st = this.requireCharts('Relax');
      const o = merge(st.opts, opts);
      const t0 = now();
      const iterations = opts && opts.iterations !== undefined ? opts.iterations : Math.max(20, o.iterations);
      let s = now();
      for (let i = 0; i < st.charts.length; i++) {
        if (shouldCancel && shouldCancel()) break;
        const c = st.charts[i];
        if (C.countFlips(c.local) > 0) C.initChart(c.local, 'tutte');
        const r = C.optimizeChart(c.local, { energy: o.optimizer === 'arap' ? 'arap' : 'sd', iterations, anderson: o.anderson, shouldCancel });
        c.opt = { energyBefore: c.opt ? c.opt.energyBefore : r.energyBefore, energyAfter: r.energyAfter };
        c.flips = C.countFlips(c.local);
        if (progress) progress('optimize', i + 1, st.charts.length);
      }
      st.timings = { segment: 0, topology: 0, flatten: 0, optimize: now() - s, pack: 0, metrics: 0, total: 0 };
      st.opts = o;
      st.notes = ['Relaxed ' + st.charts.length + ' chart(s) with ' + (o.optimizer === 'arap' ? 'ARAP' : 'SLIM') + ' (' + iterations + ' iterations).'];
      this.packState(o, progress);
      return this.finish(st.timings, t0, progress);
    }

    repack(...args) {
      const { opts, progress } = cb(args);
      const st = this.requireCharts('Repack');
      const o = merge(st.opts, opts);
      const t0 = now();
      st.opts = o;
      st.timings = { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 };
      st.notes = ['Repacked ' + st.charts.length + ' chart(s) (' + o.packing.method + ', ' + o.packing.resolution + 'px, padding ' + o.packing.paddingTexels + ').'];
      this.packState(o, progress);
      return this.finish(st.timings, t0, progress);
    }

    optimizeSearch(...args) {
      const { opts, progress, shouldCancel } = cb(args);
      const m = this.requireMesh();
      const o = merge(DEFAULTS, opts);
      const a = o.segmentation.angleDeg;
      let angles = Array.from(new Set([a - 15, a, a + 15].map(v => Math.max(20, Math.min(88, v)))));
      if (m.faceCount > 30000) angles = angles.slice(0, 2);
      const trials = [];
      let best = null, bestSnap = null;
      for (let i = 0; i < angles.length; i++) {
        if (shouldCancel && shouldCancel()) break;
        const trialOpts = merge(o, { segmentation: { angleDeg: angles[i] } });
        const r = this.unwrap(trialOpts, progress ? (stage, d, tot) => progress('trial ' + (i + 1) + '/' + angles.length + ': ' + stage, d, tot) : null, shouldCancel);
        if (r.cancelled) break;
        const summary = { chartCount: r.metrics.chartCount, score: r.metrics.score.score, sdMean: r.metrics.sdMean, seamNorm: r.metrics.seamNorm, textureEff: r.metrics.efficiency.textureEff, valid: r.metrics.score.valid };
        trials.push({ params: { angleDeg: angles[i] }, metrics: summary, score: r.metrics.score.score });
        if (!best || C.compareMetrics(r.metrics, best.metrics) < 0) { best = r; bestSnap = this.snapshot(); }
      }
      if (!best) return { cancelled: true };
      this.restoreState(bestSnap);
      best.notes = best.notes.concat(['Search tried segmentation angles ' + angles.join('°, ') + '° and kept ' + trials[trials.findIndex(tr => tr.score === best.metrics.score.score)].params.angleDeg + '°.']);
      return { best, trials };
    }

    metrics(...args) {
      const { opts } = cb(args);
      if (!this.state) throw new Error('Nothing unwrapped yet.');
      const o = merge(this.state.opts, opts);
      return C.computeMetrics(this.mesh, this.state.uv, this.state.faceChart, this.state.cut, { preset: o.preset, resolution: o.packing.resolution, paddingTexels: this.state.packing ? o.packing.paddingTexels : undefined, rasterRes: Math.min(1024, o.packing.resolution) });
    }

    /* ---------------- undo ---------------- */
    snapshot() {
      if (!this.state) return { empty: true, manualCut: this.manualCut ? Uint8Array.from(this.manualCut) : null };
      const st = this.state;
      return {
        opts: JSON.parse(JSON.stringify(st.opts)),
        uv: Float32Array.from(st.uv), faceChart: Int32Array.from(st.faceChart),
        cut: Uint8Array.from(st.cut), manualCut: Uint8Array.from(this.manualCut),
        chartFaces: st.charts.map(c => Int32Array.from(c.faces)),
        chartUV: st.charts.map(c => Float64Array.from(c.local.uv)),
        notes: st.notes.slice(), packing: st.packing ? JSON.parse(JSON.stringify(st.packing)) : null,
        projection: !!st.projection
      };
    }

    restoreState(snap) {
      const m = this.requireMesh();
      if (!snap || snap.empty) { this.state = null; if (snap && snap.manualCut) this.manualCut = Uint8Array.from(snap.manualCut); return; }
      if (snap.uv.length !== 6 * m.faceCount) throw new Error('Snapshot belongs to a different mesh.');
      this.manualCut = Uint8Array.from(snap.manualCut);
      const cut = Uint8Array.from(snap.cut);
      const charts = snap.chartFaces.map((faces, i) => {
        const local = C.buildChartLocal(m, faces, cut);
        local.uv.set(snap.chartUV[i]);
        return { faces: local.faces, local, init: { method: 'restored', fallbacks: [] }, opt: null, flips: C.countFlips(local) };
      });
      this.lastCut = cut;
      this.state = { opts: snap.opts, charts, uv: Float32Array.from(snap.uv), faceChart: Int32Array.from(snap.faceChart), cut, packing: snap.packing, notes: snap.notes.slice(), timings: { segment: 0, topology: 0, flatten: 0, optimize: 0, pack: 0, metrics: 0, total: 0 }, projection: snap.projection };
      if (charts.length) {
        // re-attach rects/transforms lazily: rects from the packed uv
        for (let ci = 0; ci < charts.length; ci++) {
          let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
          for (const f of charts[ci].faces) for (let k = 0; k < 3; k++) {
            const c = 3 * f + k, u = snap.uv[2 * c], v = snap.uv[2 * c + 1];
            if (u < mnx) mnx = u; if (u > mxx) mxx = u; if (v < mny) mny = v; if (v > mxy) mxy = v;
          }
          charts[ci].rect = isFinite(mnx) ? { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny } : null;
        }
      }
    }

    restore(snap, ...rest) {
      const { progress } = cb(rest.length ? [undefined, ...rest] : []);
      this.restoreState(snap);
      if (!this.state) return null;
      const t0 = now();
      return this.finish(this.state.timings, t0, progress);
    }
  }

  return { UVEngine, ENGINE_DEFAULTS: DEFAULTS, ENGINE_VERSION: VERSION };
});
