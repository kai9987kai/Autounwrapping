/* Application controller: wires the engine client, views, panels and controls. */
(function (root) {
  'use strict';
  const U = root.UVApp;
  const $ = (id) => document.getElementById(id);
  const THREE = root.THREE;
  const LS = { settings: 'uvtk4.settings', theme: 'uvtk4.theme', view: 'uvtk4.view' };

  const UI_PRESETS = {
    game_hero: { hint: 'Low stretch, 2K texture, 8 texel padding (mip-safe to level 3).', s: { preset: 'game_hero', mode: 'atlas', parameterizer: 'bff', optimizer: 'slim', iterations: 16, segmentation: { angleDeg: 50, maxFaces: 8000, lloydIterations: 3 }, packing: { method: 'bitmap', resolution: 2048, paddingTexels: 8, rotations: 4, equalizeDensity: true }, seams: { visibility: false, sharpAngleDeg: 0 } } },
    game_prop: { hint: 'Balanced quality for props: 1K texture, 4 texel padding.', s: { preset: 'game_prop', mode: 'atlas', parameterizer: 'bff', optimizer: 'slim', iterations: 10, segmentation: { angleDeg: 60, maxFaces: 8000, lloydIterations: 2 }, packing: { method: 'bitmap', resolution: 1024, paddingTexels: 4, rotations: 4, equalizeDensity: true }, seams: { visibility: false, sharpAngleDeg: 0 } } },
    lightmap: { hint: 'Unique, even texel density, small texture; hard edges become seams.', s: { preset: 'lightmap', mode: 'atlas', parameterizer: 'bff', optimizer: 'slim', iterations: 8, segmentation: { angleDeg: 45, maxFaces: 6000, lloydIterations: 2 }, packing: { method: 'bitmap', resolution: 512, paddingTexels: 3, rotations: 4, equalizeDensity: true }, seams: { visibility: false, sharpAngleDeg: 80 } } },
    film_udim: { hint: 'Near-isometric charts for film work: 4K texture, long optimisation.', s: { preset: 'film_udim', mode: 'atlas', parameterizer: 'bff', optimizer: 'slim', iterations: 30, segmentation: { angleDeg: 40, maxFaces: 12000, lloydIterations: 4 }, packing: { method: 'bitmap', resolution: 4096, paddingTexels: 12, rotations: 4, equalizeDensity: true }, seams: { visibility: false, sharpAngleDeg: 0 } } },
    fast: { hint: 'Instant feedback: no optimisation, rectangle packing.', s: { preset: 'game_prop', mode: 'atlas', parameterizer: 'bff', optimizer: 'none', iterations: 0, segmentation: { angleDeg: 55, maxFaces: 8000, lloydIterations: 0 }, packing: { method: 'skyline', resolution: 1024, paddingTexels: 4, rotations: 2, equalizeDensity: true }, seams: { visibility: false, sharpAngleDeg: 0 } } }
  };

  const STAGES = { segment: 'Segmenting charts', topology: 'Cutting charts into disks', flatten: 'Flattening (BFF)', optimize: 'Optimising distortion (SLIM)', pack: 'Packing atlas', metrics: 'Measuring quality', visibility: 'Computing visibility' };

  const state = {
    client: null, core: null, viewport: null, uvView: null,
    model: null, meshInfo: null, result: null, baked: null, bakeStale: false,
    settings: null, presetKey: 'game_hero', undo: [], redo: [], compare: [], busy: false, selected: -1,
    visCache: null, analysis: null
  };

  /* ---------------- utilities ---------------- */
  function toast(msg, kind, ms) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms || (kind === 'error' ? 7000 : 3500));
  }
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage may be blocked on file:// */ } };
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const getPath = (o, p) => p.split('.').reduce((a, k) => a == null ? a : a[k], o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]] = a[ks[i]] || {}; a[ks[ks.length - 1]] = v; };
  const baseName = (n) => U.exporters.safeName(n || 'model');

  function setStatus(text) { $('status-text').textContent = text; }
  function setProgress(frac, indeterminate) {
    $('progress').classList.toggle('indeterminate', !!indeterminate);
    $('progress-fill').style.width = indeterminate ? '' : Math.round(100 * Math.max(0, Math.min(1, frac))) + '%';
  }
  function setBusy(on, label) {
    state.busy = on;
    document.querySelectorAll('[data-setting], #preset, #btn-examples, #btn-export, #btn-adopt-source, #btn-transform-chart').forEach(el => { el.disabled = on; });
    for (const id of ['btn-unwrap', 'btn-relax', 'btn-repack', 'btn-search', 'btn-open', 'btn-bake', 'btn-benchmark', 'btn-pin']) if ($(id)) $(id).disabled = on || ($(id).dataset.needs === 'result' && !state.result);
    $('btn-cancel').hidden = !on;
    if (on) { setStatus(label || 'Working…'); setProgress(0, true); }
    else { setProgress(0, false); updateButtons(); }
  }
  function updateButtons() {
    const hasCharts = !!(state.result && !state.result.projection && state.result.charts.length);
    $('btn-relax').disabled = state.busy || !hasCharts;
    $('btn-repack').disabled = state.busy || !hasCharts;
    $('btn-undo').disabled = state.busy || !state.undo.length;
    $('btn-redo').disabled = state.busy || !state.redo.length;
    const hasUV = !!(state.model && state.model.originalUV);
    const hasMap = !!(state.model && state.model.materials.some(m => m.map));
    $('btn-analyze-source').disabled = state.busy || !hasUV;
    $('btn-seams-source').disabled = state.busy || !hasUV;
    $('btn-adopt-source').disabled = state.busy || !hasUV;
    $('btn-transform-chart').disabled = state.busy || state.selected < 0 || !!state.analysis || !hasCharts;
    $('btn-bake').disabled = state.busy || !hasUV || !state.result;
    $('bake-hint').textContent = hasUV ? (hasMap ? 'This model has a texture: re-bake it onto the new UVs.' : 'Imported UVs found (no texture): re-bake transfers material colours.') : 'Load a textured glTF / GLB / OBJ to transfer its texture onto the new UVs.';
    $('view-texture').querySelector('[value="original"]').disabled = !(hasUV && hasMap);
    $('view-texture').querySelector('[value="baked"]').disabled = !state.baked;
    $('uv-bg').querySelector('[value="baked"]').disabled = !state.baked;
  }

  /* ---------------- settings ---------------- */
  function defaultSettings() { return clone(UI_PRESETS.game_hero.s); }

  function syncControls() {
    document.querySelectorAll('[data-setting]').forEach(el => {
      const v = getPath(state.settings, el.dataset.setting);
      if (el.type === 'checkbox') el.checked = !!v;
      else if (v !== undefined) el.value = String(v);
      const out = $(el.id + '-out');
      if (out) out.textContent = formatSetting(el.id, el.value);
    });
    $('preset').value = state.presetKey;
    $('preset-hint').textContent = UI_PRESETS[state.presetKey] ? UI_PRESETS[state.presetKey].hint : 'Custom settings.';
  }
  function formatSetting(id, v) {
    if (id === 'angle') return v + '°';
    if (id === 'sharp') return +v ? v + '°' : 'off';
    return v;
  }
  function bindSettings() {
    document.querySelectorAll('[data-setting]').forEach(el => {
      const handler = () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'range' || el.dataset.type === 'number') v = Number(v);
        setPath(state.settings, el.dataset.setting, v);
        const out = $(el.id + '-out');
        if (out) out.textContent = formatSetting(el.id, el.value);
        $('preset-hint').textContent = 'Custom settings (based on ' + $('preset').selectedOptions[0].textContent + ').';
        save(LS.settings, { presetKey: state.presetKey, settings: state.settings });
      };
      el.addEventListener(el.type === 'range' ? 'input' : 'change', handler);
    });
    $('preset').addEventListener('change', () => applyPreset($('preset').value));
  }
  function applyPreset(key) {
    const p = UI_PRESETS[key];
    if (!p) return;
    state.presetKey = key;
    state.settings = clone(p.s);
    syncControls();
    save(LS.settings, { presetKey: key, settings: state.settings });
    if (state.model && !state.busy) runUnwrap();
  }

  /* ---------------- results ---------------- */
  function heatFor(mode) {
    const r = state.result;
    if (mode === 'none' || !r) return null;
    const m = r.metrics, F = m.faces, out = new Float32Array(F);
    if (mode === 'visibility') {
      if (!state.visCache) {
        const C = state.core, mesh = C.buildMesh(state.model.positions);
        state.visCache = C.computeVisibility(mesh, { views: 48 }).faceVis;
      }
      for (let f = 0; f < F; f++) out[f] = 1 - Math.min(1, 2 * state.visCache[f]);
      return out;
    }
    for (let f = 0; f < F; f++) {
      const flag = m.faceFlag[f];
      if (mode === 'flips') { out[f] = flag === 1 ? 1 : 0.05; continue; }
      if (flag === 1) { out[f] = 1; continue; }
      if (flag === 2) { out[f] = 0.5; continue; }
      if (mode === 'sd') out[f] = Math.log2(Math.max(1, m.faceSD[f]));
      else if (mode === 'area') out[f] = m.faceAreaLog2[f] / 1.5;
      else if (mode === 'angle') out[f] = Math.max(m.cornerAngleErr[3 * f], m.cornerAngleErr[3 * f + 1], m.cornerAngleErr[3 * f + 2]) / 0.6;
      else if (mode === 'density') { const pc = m.perChart[r.faceChart[f]]; out[f] = pc && pc.density > 0 ? Math.abs(Math.log2(pc.density)) : 1; }
    }
    return out;
  }

  async function refreshManualSeams() {
    if (!state.model) return;
    try { state.viewport.setManualSeams(await state.client.edgeSegments('manual')); } catch (e) { /* no mesh */ }
  }

  function applyResult(r, opts) {
    opts = opts || {};
    state.result = r;
    state.analysis = null;
    if (r.opts) {
      state.settings = clone(r.opts);
      state.presetKey = r.opts.preset || 'game_hero';
      syncControls();
      save(LS.settings, { presetKey: state.presetKey, settings: state.settings });
    }
    state.selected = -1;
    if (state.baked) state.bakeStale = true;
    state.viewport.setResult(r);
    state.viewport.highlightChart(-1);
    state.viewport.setHeat($('view-heat').value, heatFor($('view-heat').value));
    state.uvView.setData({ uv: r.uv, faceChart: r.faceChart, metrics: r.metrics, resolution: r.packing ? r.packing.resolution : state.settings.packing.resolution, chartCount: r.metrics.chartCount });
    renderPanels(r);
    U.panels.pushHistory(r.metrics);
    if (r.notes && r.notes.length) U.panels.log(r.notes);
    const m = r.metrics;
    U.panels.log((opts.label || 'Result') + ': score ' + m.score.score + ', ' + m.chartCount + ' charts, SD ' + m.sdMean.toFixed(4) + ', texture use ' + (100 * m.efficiency.textureEff).toFixed(1) + '%, ' + Math.round(r.timings.total) + ' ms');
    setStatus((opts.label || 'Done') + ' — score ' + m.score.score + ' · ' + m.chartCount + ' charts · ' + Math.round(r.timings.total) + ' ms');
    refreshManualSeams();
    updateButtons();
  }
  function renderPanels(r) {
    U.panels.renderScore(r ? r.metrics : null);
    U.panels.renderImprovements(r ? r.metrics : null, fixMetric);
    U.panels.renderMetrics(r);
    U.panels.renderBake(r);
    U.panels.renderChart(null);
  }

  function chartInfo(id) {
    const r = state.result;
    if (!r || id < 0) return null;
    const pc = r.metrics.perChart[id], ch = r.charts[id] || {};
    return pc ? Object.assign({}, pc, { initMethod: ch.initMethod, fallbacks: ch.fallbacks }) : null;
  }
  function selectChart(id, from) {
    state.selected = id;
    state.viewport.highlightChart(id);
    if (from !== 'uv') state.uvView.select(id);
    U.panels.renderChart(chartInfo(id));
    updateButtons();
  }

  /* ---------------- engine operations ---------------- */
  async function pushUndo(label) {
    if (!state.model) return;
    try {
      const snap = await state.client.snapshot();
      state.undo.push({ snap, label });
      if (state.undo.length > 15) state.undo.shift();
      state.redo = [];
    } catch (e) { /* nothing to snapshot */ }
  }

  /* Drops the current result from every view (engine has no result any more). */
  function clearResult() {
    state.result = null;
    state.analysis = null;
    state.selected = -1;
    state.viewport.setResult(null);
    state.viewport.highlightChart(-1);
    state.viewport.setHeat($('view-heat').value, null);
    state.uvView.setData(null);
    renderPanels(null);
    updateButtons();
  }

  async function takeSnapshot(label) {
    try { return { snap: await state.client.snapshot(), label }; } catch (e) { return null; }
  }
  function commitUndo(entry) {
    if (!entry) return;
    state.undo.push(entry);
    if (state.undo.length > 15) state.undo.shift();
    state.redo = [];
  }

  async function run(label, fn, opts) {
    if (state.busy) return null;
    if (!state.model) { toast('Load a model first.', 'warn'); return null; }
    opts = opts || {};
    setBusy(true, label + '…');
    let entry = null;
    try {
      if (opts.undo !== false) entry = await takeSnapshot(label);
      const t0 = performance.now();
      const r = await fn();
      if (r && (r.metrics || r.best)) commitUndo(entry);
      if (r && r.metrics) applyResult(r, { label });
      else if (r && r.best) applyResult(r.best, { label });
      if (opts.toast !== false && r && (r.metrics || r.best)) toast(label + ' finished in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s — score ' + (r.metrics || r.best.metrics).score.score, 'success', 2500);
      return r;
    } catch (err) {
      if (err && err.name === 'CancelError') {
        toast('Cancelled.', 'warn');
        setStatus('Cancelled');
        // a worker cancel restarts the engine with only mesh + seams: bring the previous result back
        if (state.client.mode === 'worker') {
          try {
            await state.client.ready;
            const back = entry ? await state.client.restore(entry.snap) : null;
            if (back) applyResult(back, { label: 'Cancelled — previous result kept' }); else clearResult();
          } catch (e) { clearResult(); }
        }
      }
      else { console.error(err); toast(label + ' failed: ' + (err && err.message ? err.message : err), 'error'); setStatus(label + ' failed'); }
      return null;
    } finally {
      setBusy(false);
    }
  }

  const runUnwrap = () => run('Unwrap', () => state.client.unwrap(state.settings));
  const runRelax = () => run('Relax', () => state.client.relax(Object.assign({}, state.settings, { iterations: Math.max(24, state.settings.iterations * 2) })));
  const runRepack = () => run('Repack', () => state.client.repack(state.settings));
  const adoptSource = () => run('Use imported layout', () => state.client.adoptSource(state.settings));
  async function transformSelected() {
    const id = state.selected;
    if (id < 0 || state.analysis) return;
    const edit = { rotateDegrees: Number($('chart-rotation').value), scale: Number($('chart-scale').value), offsetU: Number($('chart-u').value), offsetV: Number($('chart-v').value) };
    const r = await run('Edit chart ' + id, () => state.client.transformChart(id, edit));
    if (r && r.metrics) selectChart(id);
  }
  async function runSearch() {
    const r = await run('Auto-tune', () => state.client.optimizeSearch(state.settings));
    if (r && r.trials) {
      U.panels.log(r.trials.map(t => 'trial angle ' + t.params.angleDeg + '° → score ' + t.score));
      const best = r.best.opts && r.best.opts.segmentation ? r.best.opts.segmentation.angleDeg : null;
      if (best) { state.settings.segmentation.angleDeg = best; syncControls(); }
    }
  }

  function fixMetric(metric) {
    const s = state.settings;
    if (metric === 'sd' || metric === 'area' || metric === 'gate') return runRelax();
    if (metric === 'angle') { s.parameterizer = 'bff'; s.segmentation.angleDeg = Math.max(20, s.segmentation.angleDeg - 10); syncControls(); return runUnwrap(); }
    if (metric === 'td') { s.packing.equalizeDensity = true; syncControls(); return runRepack(); }
    if (metric === 'waste') { s.packing.method = 'bitmap'; s.packing.rotations = 4; syncControls(); return runRepack(); }
    if (metric === 'seams' || metric === 'frag') { s.segmentation.angleDeg = Math.min(88, s.segmentation.angleDeg + 10); syncControls(); return runUnwrap(); }
  }

  async function undo() {
    if (state.busy || !state.undo.length) return;
    setBusy(true, 'Undo…');
    try {
      const current = await state.client.snapshot();
      const prev = state.undo.pop();
      state.redo.push({ snap: current, label: prev.label });
      const r = await state.client.restore(prev.snap);
      if (r) applyResult(r, { label: 'Undo ' + prev.label }); else clearResult();
      await refreshManualSeams();
    } catch (e) { toast('Undo failed: ' + e.message, 'error'); } finally { setBusy(false); }
  }
  async function redo() {
    if (state.busy || !state.redo.length) return;
    setBusy(true, 'Redo…');
    try {
      const current = await state.client.snapshot();
      const next = state.redo.pop();
      state.undo.push({ snap: current, label: next.label });
      const r = await state.client.restore(next.snap);
      if (r) applyResult(r, { label: 'Redo ' + next.label }); else clearResult();
      await refreshManualSeams();
    } catch (e) { toast('Redo failed: ' + e.message, 'error'); } finally { setBusy(false); }
  }

  /* ---------------- models ---------------- */
  function exampleModels() {
    const T = THREE;
    const displaced = (geo, amp, freq) => {
      const p = geo.attributes.position, v = new T.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const n = Math.sin(freq * v.x + 1.3) * Math.cos(freq * v.y) * Math.sin(freq * v.z + 0.7);
        v.multiplyScalar(1 + amp * n);
        p.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();
      return geo;
    };
    const lathe = () => {
      const pts = [];
      for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(new T.Vector2(0.25 + 0.35 * Math.sin(Math.PI * t * 1.2) + 0.1 * t, t * 2 - 1)); }
      return new T.LatheGeometry(pts, 64);
    };
    const terrain = () => {
      const g = new T.PlaneGeometry(3, 3, 80, 80), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, 0.25 * Math.sin(2.2 * x) * Math.cos(1.7 * y) + 0.1 * Math.sin(5 * x + 3 * y)); }
      g.rotateX(-Math.PI / 2); g.computeVertexNormals();
      return g;
    };
    return [
      { key: 'torusKnot', name: 'Torus knot', make: () => new T.TorusKnotGeometry(0.8, 0.3, 160, 24) },
      { key: 'texturedSphere', name: 'Textured sphere (re-bake demo)', textured: true, make: () => new T.SphereGeometry(1, 64, 40) },
      { key: 'blob', name: 'Organic blob', make: () => displaced(new T.IcosahedronGeometry(1, 5), 0.22, 3.1) },
      { key: 'vase', name: 'Vase (lathe)', make: lathe },
      { key: 'capsule', name: 'Capsule', make: () => (T.CapsuleGeometry ? new T.CapsuleGeometry(0.5, 1.2, 12, 32) : new T.CylinderGeometry(0.5, 0.5, 2, 32, 6)) },
      { key: 'torus', name: 'Torus (genus 1)', make: () => new T.TorusGeometry(1, 0.38, 32, 96) },
      { key: 'box', name: 'Rounded box', make: () => displaced(new T.BoxGeometry(1.6, 1, 1, 12, 8, 8), 0, 0) },
      { key: 'terrain', name: 'Terrain patch (open)', make: terrain }
    ];
  }

  async function loadExample(key) {
    const ex = exampleModels().find(e => e.key === key) || exampleModels()[0];
    const geo = ex.make();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    if (ex.textured) { const t = new THREE.CanvasTexture(U.textures.colorGridCanvas(1024)); t.flipY = true; mat.map = t; mat.name = 'colorgrid'; }
    const mesh = new THREE.Mesh(geo, mat);
    const model = U.loaders.fromObject3D(mesh, ex.name, 'example');
    if (!ex.textured) model.originalUV = null;
    await setModel(model);
    if (ex.textured) { $('view-texture').value = 'original'; state.viewport.setTextureMode('original'); toast('This sphere has a textured lat-long UV layout. Unwrap, then "Re-bake texture" to move its texture onto the new atlas.', '', 6000); }
  }

  function engineProgress(p) {
    const label = STAGES[p.stage] || String(p.stage);
    setStatus(label + (p.total > 1 ? ' (' + p.done + '/' + p.total + ')' : '') + '…');
    setProgress(p.total ? p.done / p.total : 0, !p.total || p.total <= 1);
  }

  function showMeshHealth() {
    const mi = state.meshInfo, h = mi && mi.diagnostics, list = $('mesh-health-issues');
    list.replaceChildren();
    $('mesh-health-status').textContent = h ? (h.healthy ? 'clear' : 'inspect') : 'unknown';
    $('mesh-health-summary').textContent = mi ? mi.faceCount.toLocaleString() + ' triangles · ' + mi.componentCount + ' parts · ' + mi.boundaryEdgeCount + ' boundary edges. Open surfaces are supported.' : 'Load a mesh for a topology preflight.';
    for (const issue of h ? h.issues : []) {
      const li = document.createElement('li'), detail = document.createElement('small');
      li.className = issue.severity;
      li.textContent = issue.count + ' ' + issue.message.toLowerCase();
      detail.textContent = issue.action;
      li.appendChild(detail); list.appendChild(li);
    }
    if (state.model && state.model.droppedDegenerate) {
      const li = document.createElement('li');
      li.textContent = state.model.droppedDegenerate + ' degenerate triangles removed during import.';
      list.appendChild(li);
    }
  }

  // A failed candidate must never replace the live engine or its undo history.
  async function setModel(model, project) {
    if (state.busy) { toast('Wait for the current operation to finish.', 'warn'); return; }
    let candidate = null, committed = false;
    setBusy(true, project ? 'Restoring project…' : 'Preparing mesh…');
    try {
      candidate = new U.EngineClient();
      state.operationClient = candidate;
      await candidate.init();
      candidate.onProgress(engineProgress);
      const meshInfo = await candidate.setMesh(model.positions);
      if (model.originalUV) await candidate.setSourceUV(model.originalUV);
      const settings = project && project.settings ? project.settings : state.settings;
      const result = project && project.snapshot ? await candidate.restore(project.snapshot) : await candidate.unwrap(settings);
      if (result && result.cancelled) throw new Error('Load cancelled.');
      const previous = state.client;
      state.client = candidate;
      state.meshInfo = meshInfo;
      committed = true;
      if (previous) previous.dispose();
      if (project && project.settings) { state.settings = clone(project.settings); state.presetKey = project.presetKey || 'game_hero'; syncControls(); }
    state.model = model;
    state.result = null; state.analysis = null; state.selected = -1; state.baked = null; state.bakeStale = false; state.visCache = null;
    state.undo = []; state.redo = [];
    state.viewport.setModel(model);
    state.viewport.setBakedTexture(null);
    state.uvView.setBackgroundImage(null);
    if ($('uv-bg').value === 'baked') { $('uv-bg').value = 'grid'; state.uvView.setStyle({ background: 'grid' }); }
    state.compare = [];
    U.panels.renderCompare([], restoreCompare, removeCompare);
    if ($('view-texture').value === 'baked' || $('view-texture').value === 'original') { $('view-texture').value = 'checker'; state.viewport.setTextureMode('checker'); }
    state.uvView.setData(null);
    renderPanels(null);
    $('model-chip').textContent = model.name + ' · ' + model.faceCount.toLocaleString() + ' tris';
    $('model-chip').title = model.name + ' (' + model.format + ', ' + model.meshCount + ' mesh' + (model.meshCount === 1 ? '' : 'es') + ')';
    for (const w of model.warnings || []) U.panels.log(w);
      const mi = state.meshInfo;
      $('status-mesh').textContent = mi.faceCount.toLocaleString() + ' faces · ' + mi.componentCount + ' part' + (mi.componentCount === 1 ? '' : 's') + (mi.boundaryEdgeCount ? ' · open' : ' · closed') + (mi.nonManifoldEdgeCount ? ' · ' + mi.nonManifoldEdgeCount + ' non-manifold edges' : '');
      U.panels.log('Loaded ' + model.name + ': ' + mi.faceCount + ' faces, ' + mi.weldCount + ' vertices, χ = ' + mi.eulerCharacteristic);
      showMeshHealth();
      $('status-engine').textContent = 'engine: ' + state.client.mode;
      if (result) applyResult(result, { label: project ? 'Project restored' : 'Unwrap' });
      else setStatus('Project restored — no UV result saved');
      state.undo = []; state.redo = [];
    } catch (e) {
      toast('Could not load model: ' + e.message + '. Previous work kept.', 'error');
      setStatus('Load failed — previous work kept');
    } finally {
      if (candidate && !committed) candidate.dispose();
      state.operationClient = null;
      setBusy(false);
    }
  }

  async function openFiles(files) {
    if (state.busy) { toast('Wait for the current operation to finish.', 'warn'); return; }
    const list = Array.from(files || []);
    if (!list.length) return;
    if (list.length === 1 && /\.(uvtk|json)$/i.test(list[0].name) && !/\.gltf$/i.test(list[0].name)) {
      return loadProjectFile(list[0]);
    }
    setBusy(true, 'Reading ' + list.map(f => f.name).join(', ') + '…');
    try {
      const model = await U.loaders.loadFiles(list, { maxFaces: 1500000 });
      setBusy(false);
      await setModel(model);
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), 'error');
      setStatus('Load failed');
      setBusy(false);
    }
  }

  /* ---------------- baking & export ---------------- */
  function bake() {
    if (!state.result || !state.model || !state.model.originalUV) return;
    try {
      setStatus('Baking texture on the GPU…');
      const size = Number($('bake-size').value);
      const t0 = performance.now();
      state.baked = U.baker.transfer(state.viewport.renderer, {
        positions: state.model.positions, newUV: state.result.uv, oldUV: state.model.originalUV,
        faceMaterial: state.model.faceMaterial, materials: state.model.materials, size, supersample: 2
      });
      state.bakeStale = false;
      state.viewport.setBakedTexture(state.baked);
      $('view-texture').querySelector('[value="baked"]').disabled = false;
      $('view-texture').value = 'baked';
      state.viewport.setTextureMode('baked');
      state.uvView.setBackgroundImage(state.baked);
      updateButtons();
      toast('Texture re-baked at ' + size + 'px in ' + Math.round(performance.now() - t0) + ' ms. Export it as GLB or PNG.', 'success');
      U.panels.log('Baked ' + size + 'px texture from the original UVs.');
    } catch (e) {
      console.error(e);
      toast('Bake failed: ' + e.message, 'error');
    }
  }

  async function exportAction(kind) {
    const X = U.exporters, model = state.model, r = state.result, name = baseName(model && model.name);
    if (kind === 'load-project') { $('project-input').click(); return; }
    if (!model || !r) { toast('Unwrap a model first.', 'warn'); return; }
    try {
      if (state.baked && state.bakeStale && (kind === 'glb' || kind === 'baked' || kind === 'bundle')) toast('The baked texture is from an earlier layout — re-bake to match the current UVs.', 'warn', 6000);
      if (kind === 'glb') X.downloadBlob(await X.exportGLB(model.positions, r.uv, name, { normals: model.normals, texture: state.baked && !state.bakeStale ? state.baked : null }), name + '_uv.glb');
      else if (kind === 'obj') {
        const hasTex = state.baked && !state.bakeStale;
        const obj = X.exportOBJ(model.positions, r.uv, name, { normals: model.normals, mtlFileName: name + '.mtl' });
        const mtl = X.exportMTL([{ name: 'material', color: [1, 1, 1], mapFileName: hasTex ? name + '_baked.png' : null }]);
        const objText = (await obj.text()).replace(/^o .*$/m, (l) => l + '\nusemtl material');
        const entries = [{ name: name + '.obj', data: objText }, { name: name + '.mtl', data: mtl }];
        if (hasTex) entries.push({ name: name + '_baked.png', data: await X.canvasToBlob(state.baked) });
        X.downloadBlob(await X.makeZip(entries), name + '_obj.zip');
      } else if (kind === 'uvpng') {
        const size = Math.min(4096, Math.max(1024, state.settings.packing.resolution));
        X.downloadBlob(await X.exportUVPNG({ uv: r.uv, faceChart: r.faceChart, metrics: r.metrics, size, style: 'chart' }), name + '_uv_layout.png');
      } else if (kind === 'maps') {
        const size = Number($('bake-size').value);
        const maps = U.baker.maps(state.viewport.renderer, { positions: model.positions, normals: model.normals, newUV: r.uv, faceChart: r.faceChart, size });
        const entries = [];
        for (const k of ['position', 'normal', 'chartId', 'mask']) entries.push({ name: name + '_' + k + '.png', data: await X.canvasToBlob(maps[k]) });
        entries.push({ name: name + '_maps.json', data: JSON.stringify({ size, positionBBox: maps.bbox, encoding: { position: '(p - min) / (max - min)', normal: 'n * 0.5 + 0.5 (object space)' } }, null, 2) });
        X.downloadBlob(await X.makeZip(entries), name + '_uv_maps.zip');
      } else if (kind === 'baked') {
        if (!state.baked) { toast('Re-bake the texture first (Texture & bake).', 'warn'); return; }
        X.downloadBlob(await X.canvasToBlob(state.baked), name + '_baked.png');
      } else if (kind === 'report') {
        X.downloadBlob(X.exportReport(reportState()), name + '_uv_report.json');
      } else if (kind === 'bundle') {
        setStatus('Building bundle…');
        const entries = [
          { name: name + '.glb', data: await X.exportGLB(model.positions, r.uv, name, { normals: model.normals, texture: state.baked && !state.bakeStale ? state.baked : null }) },
          { name: name + '.obj', data: X.exportOBJ(model.positions, r.uv, name, { normals: model.normals }) },
          { name: name + '_uv_layout.png', data: await X.exportUVPNG({ uv: r.uv, faceChart: r.faceChart, metrics: r.metrics, size: 2048, style: 'chart' }) },
          { name: name + '_uv_report.json', data: X.exportReport(reportState()) }
        ];
        if (state.baked && !state.bakeStale) entries.push({ name: name + '_baked.png', data: await X.canvasToBlob(state.baked) });
        X.downloadBlob(await X.makeZip(entries), name + '_uv_bundle.zip');
        setStatus('Bundle exported');
      } else if (kind === 'project') {
        if (state.busy) { toast('Wait for the current operation to finish.', 'warn'); return; }
        const snapshot = await state.client.snapshot();
        X.downloadBlob(X.saveProject({ name: model.name, positions: model.positions, normals: model.normals, originalUV: model.originalUV, faceMaterial: model.faceMaterial, settings: state.settings, presetKey: state.presetKey, snapshot }), name + '.uvtk.json');
      }
    } catch (e) {
      console.error(e);
      toast('Export failed: ' + e.message, 'error');
    }
  }

  function reportState() {
    const m = state.model;
    return { model: m ? { name: m.name, format: m.format, faces: m.faceCount, meshes: m.meshCount } : null, meshInfo: state.meshInfo, settings: state.settings, result: state.result, metrics: state.result && state.result.metrics, history: state.compare.map(c => Object.assign({ label: c.label }, c.summary)) };
  }

  async function loadProjectFile(file) {
    if (state.busy) { toast('Wait for the current operation to finish.', 'warn'); return; }
    try {
      const p = await U.exporters.loadProject(file);
      const model = { positions: p.positions, normals: p.normals || null, originalUV: p.originalUV || null, faceMaterial: p.faceMaterial || null, materials: [{ name: 'material', color: [0.8, 0.8, 0.8], map: null }], name: p.name || 'project', format: 'project', meshCount: 1, faceCount: p.positions.length / 9, droppedDegenerate: 0, warnings: [] };
      if (p.settings) { state.settings = p.settings; state.presetKey = p.presetKey || 'game_hero'; syncControls(); }
      state.model = model;
      state.result = null; state.analysis = null; state.baked = null; state.bakeStale = false; state.visCache = null;
      state.undo = []; state.redo = []; state.compare = [];
      state.viewport.setModel(model);
      state.viewport.setBakedTexture(null);
      state.uvView.setBackgroundImage(null);
      state.uvView.setData(null);
      renderPanels(null);
      U.panels.renderCompare([], restoreCompare, removeCompare);
      $('model-chip').title = model.name + ' (project)';
      setBusy(true, 'Restoring project…');
      state.meshInfo = await state.client.setMesh(model.positions);
      if (model.originalUV) await state.client.setSourceUV(model.originalUV);
      const r = p.snapshot ? await state.client.restore(p.snapshot) : await state.client.unwrap(state.settings);
      setBusy(false);
      $('model-chip').textContent = model.name + ' · ' + model.faceCount.toLocaleString() + ' tris';
      $('status-mesh').textContent = state.meshInfo.faceCount.toLocaleString() + ' faces · ' + state.meshInfo.componentCount + ' part(s)';
      if (r) applyResult(r, { label: 'Project restored' });
      state.undo = []; state.redo = [];
      updateButtons();
      toast('Project loaded.', 'success');
    } catch (e) {
      setBusy(false);
      clearResult();
      toast('Could not load project: ' + e.message, 'error');
    }
  }

  /* ---------------- analysis, compare, benchmark ---------------- */
  async function analyzeSource() {
    if (state.busy || !state.model || !state.model.originalUV) return;
    setBusy(true, 'Grading imported UVs…');
    try {
      const m = await state.client.analyzeSource(state.settings);
      const pseudo = { uv: state.model.originalUV, faceChart: new Int32Array(m.faces), metrics: m, charts: [], timings: { total: 0 }, packing: null, projection: true, notes: [] };
      state.analysis = pseudo;
      renderPanels(pseudo);
      state.uvView.setData({ uv: pseudo.uv, faceChart: pseudo.faceChart, metrics: m, resolution: state.settings.packing.resolution, chartCount: 1 });
      state.compare.push(compareEntry(pseudo, 'Imported UVs', 'The model\'s original UV layout'));
      U.panels.renderCompare(state.compare, restoreCompare, removeCompare);
      toast('Imported UVs score ' + m.score.score + ' (' + m.chartCount + ' islands). Pinned to Compare.', 'success', 5000);
      setStatus('Imported UVs: score ' + m.score.score);
    } catch (e) { toast('Analysis failed: ' + e.message, 'error'); } finally { setBusy(false); }
  }

  function compareEntry(r, label, description) {
    const m = r.metrics;
    return { label, description, score: m.score.score, charts: m.chartCount, sd: m.sdMean, angle: m.angleMeanDeg, use: 100 * m.efficiency.textureEff, seams: m.seamLength3D, ms: r.timings ? r.timings.total : 0, snap: null, summary: { score: m.score.score, charts: m.chartCount, sdMean: m.sdMean } };
  }
  async function pinCurrent() {
    if (state.busy) { toast('Wait for the current operation to finish.', 'warn'); return; }
    if (!state.result) { toast('Nothing to pin yet.', 'warn'); return; }
    const s = state.settings, e = compareEntry(state.result, '#' + (state.compare.length + 1) + ' ' + s.mode + ' ' + s.segmentation.angleDeg + '°', JSON.stringify({ mode: s.mode, parameterizer: s.parameterizer, optimizer: s.optimizer, iterations: s.iterations, angle: s.segmentation.angleDeg, packing: s.packing }));
    try { e.snap = await state.client.snapshot(); e.settings = clone(s); } catch (err) { /* ignore */ }
    state.compare.push(e);
    U.panels.renderCompare(state.compare, restoreCompare, removeCompare);
  }
  async function restoreCompare(i) {
    const e = state.compare[i];
    if (!e || !e.snap) { toast('This entry cannot be restored.', 'warn'); return; }
    if (e.settings) { state.settings = clone(e.settings); syncControls(); }
    await run('Restore ' + e.label, () => state.client.restore(e.snap), { toast: false });
  }
  function removeCompare(i) { state.compare.splice(i, 1); U.panels.renderCompare(state.compare, restoreCompare, removeCompare); }

  async function benchmark() {
    if (state.busy) return;
    const current = state.model, snap = state.result ? await state.client.snapshot() : null;
    const rows = [];
    setBusy(true, 'Benchmark…');
    try {
      const exs = exampleModels();
      for (let i = 0; i < exs.length; i++) {
        const ex = exs[i];
        setStatus('Benchmark ' + (i + 1) + '/' + exs.length + ': ' + ex.name);
        const model = U.loaders.fromObject3D(new THREE.Mesh(ex.make(), new THREE.MeshStandardMaterial()), ex.name, 'example');
        await state.client.setMesh(model.positions);
        const r = await state.client.unwrap(state.settings);
        const m = r.metrics;
        rows.push({ model: ex.name, faces: m.faces, charts: m.chartCount, score: m.score.score, valid: m.score.valid, sdMean: m.sdMean, stretchL2: m.stretchL2, angleMeanDeg: m.angleMeanDeg, textureUse: m.efficiency.textureEff, seamNorm: m.seamNorm, tdCV: m.texelDensity.cv, ms: Math.round(r.timings.total) });
      }
      U.exporters.downloadBlob(U.exporters.exportCSV(rows), 'uv_benchmark.csv');
      const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
      toast('Benchmark done: mean score ' + avg.toFixed(1) + ' over ' + rows.length + ' models (CSV downloaded).', 'success', 6000);
      U.panels.log(rows.map(r => r.model + ': ' + r.score + ' (' + r.ms + ' ms)'));
    } catch (e) { toast(e && e.name === 'CancelError' ? 'Benchmark cancelled.' : 'Benchmark failed: ' + e.message, e && e.name === 'CancelError' ? 'warn' : 'error'); }
    finally {
      try {
        if (current) {
          await state.client.ready;
          await state.client.setMesh(current.positions);
          if (current.originalUV) await state.client.setSourceUV(current.originalUV);
          if (snap) { const r = await state.client.restore(snap); if (r) applyResult(r, { label: 'Restored' }); else clearResult(); }
        }
      } catch (e) {
        toast('Could not restore the model after the benchmark: ' + e.message, 'error');
        clearResult();
      } finally {
        setBusy(false);
      }
    }
  }

  /* ---------------- wiring ---------------- */
  function bindUI() {
    $('btn-open').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
    $('project-input').addEventListener('change', (e) => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); e.target.value = ''; });
    $('btn-unwrap').addEventListener('click', runUnwrap);
    $('btn-relax').addEventListener('click', runRelax);
    $('btn-repack').addEventListener('click', runRepack);
    $('btn-search').addEventListener('click', runSearch);
    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-cancel').addEventListener('click', () => state.client.cancel());
    $('btn-bake').addEventListener('click', bake);
    $('btn-analyze-source').addEventListener('click', analyzeSource);
    $('btn-benchmark').addEventListener('click', benchmark);
    $('btn-pin').addEventListener('click', pinCurrent);
    $('btn-compare-clear').addEventListener('click', () => { state.compare = []; U.panels.renderCompare([], restoreCompare, removeCompare); });

    // seams
    const seamTool = $('btn-seamtool');
    const setSeamTool = (on) => { seamTool.setAttribute('aria-pressed', String(on)); state.viewport.setSeamTool(on); setStatus(on ? 'Seam tool: click an edge to cut / weld (Shift remove, Alt add). Unwrap to apply.' : 'Seam tool off'); };
    seamTool.addEventListener('click', () => setSeamTool(seamTool.getAttribute('aria-pressed') !== 'true'));
    $('btn-seams-angle').addEventListener('click', async () => {
      if (!state.model || state.busy) return;
      await pushUndo('Mark hard edges');
      const deg = state.settings.seams.sharpAngleDeg || 60;
      const n = await state.client.seamsFromAngle(deg);
      await refreshManualSeams(); updateButtons();
      toast(n + ' edge(s) sharper than ' + deg + '° marked as seams. Unwrap to apply.');
    });
    $('btn-seams-source').addEventListener('click', async () => {
      if (!state.model || state.busy) return;
      await pushUndo('Imported seams');
      const r = await state.client.seamsFromSourceUV();
      await refreshManualSeams(); updateButtons();
      toast(r.added + ' seam edge(s) taken from ' + r.islands + ' imported UV islands.');
      runUnwrap();
    });
    $('btn-seams-clear').addEventListener('click', async () => {
      if (!state.model || state.busy) return;
      await pushUndo('Clear seams');
      await state.client.clearSeams();
      await refreshManualSeams(); updateButtons();
    });

    // viewport
    const vp = state.viewport;
    vp.on('pick', async ({ hit, shift, alt, seamTool: tool }) => {
      if (!hit) { if (!tool) selectChart(-1); return; }
      if (tool && !state.busy) {
        const value = shift ? 0 : alt ? 1 : undefined;
        if (state.undo.length === 0 || state.undo[state.undo.length - 1].label !== 'Seam edit') await pushUndo('Seam edit');
        const res = await state.client.toggleSeamEdge(hit.face, hit.edge, value);
        if (res.edge >= 0) { await refreshManualSeams(); setStatus('Edge ' + res.edge + (res.value ? ' cut' : ' welded') + ' — press Unwrap (U) to apply'); updateButtons(); }
        return;
      }
      if (state.result) selectChart(state.result.faceChart[hit.face]);
    });
    vp.on('hover', (hit) => {
      const r = state.result;
      $('hover3d').textContent = hit ? ('face ' + hit.face + (r ? ' · chart ' + r.faceChart[hit.face] + (r.metrics.faceSD ? ' · SD ' + (isFinite(r.metrics.faceSD[hit.face]) ? r.metrics.faceSD[hit.face].toFixed(3) : 'flipped') : '') : '')) : '';
    });
    $('view-texture').addEventListener('change', (e) => vp.setTextureMode(e.target.value));
    $('view-heat').addEventListener('change', (e) => { try { vp.setHeat(e.target.value, heatFor(e.target.value)); } catch (err) { toast(err.message, 'error'); } });
    $('view-seams').addEventListener('change', (e) => vp.setSeamsVisible(e.target.checked));
    $('view-wire').addEventListener('change', (e) => vp.setWireframe(e.target.checked));
    $('btn-turntable').addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); vp.setTurntable(on); });
    $('btn-fit3d').addEventListener('click', () => vp.frame());
    $('btn-shot').addEventListener('click', async () => U.exporters.downloadBlob(await vp.screenshot(), baseName(state.model && state.model.name) + '_view.png'));

    // uv view
    const uvv = state.uvView;
    uvv.on('select', ({ chartId }) => selectChart(chartId, 'uv'));
    uvv.on('hover', (h) => {
      if (!h) { $('hoveruv').textContent = ''; return; }
      const res = state.settings.packing.resolution;
      $('hoveruv').textContent = 'u ' + h.u.toFixed(4) + '  v ' + h.v.toFixed(4) + '  px ' + Math.floor(h.u * res) + ',' + Math.floor((1 - h.v) * res) + (h.chartId >= 0 ? '  · chart ' + h.chartId : '');
    });
    $('uv-mode').addEventListener('change', (e) => uvv.setStyle({ mode: e.target.value }));
    $('uv-bg').addEventListener('change', (e) => uvv.setStyle({ background: e.target.value === 'baked' ? 'image' : e.target.value }));
    $('uv-texels').addEventListener('change', (e) => uvv.setStyle({ texels: e.target.checked }));
    $('btn-fituv').addEventListener('click', () => uvv.resetView());

    // layout, splitter, theme
    document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => setLayout(b.dataset.layout)));
    const split = $('splitter'), stage = $('stage');
    split.addEventListener('pointerdown', (e) => {
      split.classList.add('dragging'); split.setPointerCapture(e.pointerId);
      const stacked = window.matchMedia('(max-width: 1024px)').matches;
      const move = (ev) => {
        const r = stage.getBoundingClientRect();
        const t = stacked ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
        const frac = Math.max(0.15, Math.min(0.85, t));
        stage.style.setProperty(stacked ? '--split-rows' : '--split', frac / (1 - frac) + 'fr');
      };
      const up = () => {
        split.classList.remove('dragging');
        for (const [ev, fn] of [['pointermove', move], ['pointerup', up], ['pointercancel', up], ['lostpointercapture', up]]) split.removeEventListener(ev, fn);
      };
      split.addEventListener('pointermove', move);
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) split.addEventListener(ev, up);
    });
    $('btn-theme').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      save(LS.theme, next);
      state.viewport.setBackground(); state.uvView.draw(); U.panels.refreshTheme();
    });

    // menus
    document.querySelectorAll('.menu > button').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.parentElement, open = !menu.classList.contains('open');
      document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
      menu.classList.toggle('open', open);
    }));
    document.addEventListener('click', () => document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')));
    $('menu-export').querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => exportAction(b.dataset.export)));
    const exMenu = $('menu-examples');
    for (const ex of exampleModels()) {
      const b = document.createElement('button');
      b.textContent = ex.name;
      b.addEventListener('click', () => loadExample(ex.key));
      exMenu.appendChild(b);
    }

    // help
    const dlg = $('help-dialog');
    $('btn-help').addEventListener('click', () => { U.help.render($('help-body'), $('help-search').value); dlg.showModal(); $('help-search').focus(); });
    $('help-search').addEventListener('input', (e) => U.help.render($('help-body'), e.target.value));

    // drag & drop
    let depth = 0;
    const overlay = $('drop-overlay');
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { depth++; overlay.hidden = false; e.preventDefault(); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
    window.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; overlay.hidden = true; if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });

    // keyboard
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag) && e.key !== 'Escape') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'escape') { if (state.busy) state.client.cancel(); else if (seamTool.getAttribute('aria-pressed') === 'true') setSeamTool(false); }
      else if (k === 'u') runUnwrap();
      else if (k === 'r' && !$('btn-relax').disabled) runRelax();
      else if (k === 'p' && !$('btn-repack').disabled) runRepack();
      else if (k === 'o') $('file-input').click();
      else if (k === 's') setSeamTool(seamTool.getAttribute('aria-pressed') !== 'true');
      else if (k === 'f') state.viewport.frame();
      else if (k === 'w') { $('view-wire').checked = !$('view-wire').checked; state.viewport.setWireframe($('view-wire').checked); }
      else if (k === '1') setLayout('3d'); else if (k === '2') setLayout('split'); else if (k === '3') setLayout('uv');
      else if (e.key === '?') $('btn-help').click();
    });
  }

  function setLayout(layout) {
    const stage = $('stage');
    stage.classList.remove('layout-3d', 'layout-uv', 'layout-split');
    stage.classList.add('layout-' + layout);
    document.querySelectorAll('[data-layout]').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
    save(LS.view, { layout });
  }

  async function boot() {
    const theme = load(LS.theme);
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    const saved = load(LS.settings);
    state.presetKey = saved && saved.presetKey ? saved.presetKey : 'game_hero';
    state.settings = saved && saved.settings ? Object.assign(defaultSettings(), saved.settings) : defaultSettings();
    state.core = root.UVCore.build();
    U.PRESETS = state.core.PRESETS;
    if (!root.WebGLRenderingContext) toast('WebGL is not available: the 3D view will not work.', 'error');
    state.viewport = new U.Viewport($('viewport'));
    state.uvView = new U.UVView($('uv-canvas'));
    U.panels.initCharts();
    syncControls();
    bindSettings();
    bindUI();
    const view = load(LS.view);
    if (view && view.layout) setLayout(view.layout);
    setStatus('Starting engine…');
    state.client = await new U.EngineClient().init();
    $('status-engine').textContent = state.client.mode === 'worker' ? 'engine: worker' : 'engine: main thread';
    $('status-engine').title = state.client.mode === 'worker' ? 'The UV kernel runs in a background Web Worker.' : 'Workers are unavailable here (' + (state.client.workerError ? state.client.workerError.message : 'unknown') + '); running on the main thread.';
    state.client.onProgress((p) => {
      const label = STAGES[p.stage] || String(p.stage).replace(/^trial (\d+\/\d+): (\w+)/, (m, n, s) => 'Trial ' + n + ' · ' + (STAGES[s] || s));
      setStatus(label + (p.total > 1 ? ' (' + p.done + '/' + p.total + ')' : '') + '…');
      setProgress(p.total ? p.done / p.total : 0, !p.total || p.total <= 1);
    });
    updateButtons();
    await loadExample('torusKnot');
  }

  document.addEventListener('DOMContentLoaded', () => boot().catch((e) => { console.error(e); toast('Startup failed: ' + e.message, 'error', 20000); }));
  U.app = state;
})(typeof window !== 'undefined' ? window : globalThis);
