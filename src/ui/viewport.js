/* 3D viewport (Three.js r141): model display, textures, distortion overlays,
 * seams, chart highlight, picking for the seam tool. Renders on demand. */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};

  /* Perceptual blue -> teal -> yellow -> red ramp (t in 0..1). */
  function heatColor(t, out, o) {
    t = Math.max(0, Math.min(1, t));
    const stops = [[0, 0.19, 0.35, 0.78], [0.33, 0.13, 0.72, 0.66], [0.66, 0.98, 0.80, 0.25], [1, 0.90, 0.18, 0.18]];
    let i = 1;
    while (i < stops.length - 1 && t > stops[i][0]) i++;
    const a = stops[i - 1], b = stops[i], u = (t - a[0]) / (b[0] - a[0]);
    out[o] = a[1] + (b[1] - a[1]) * u; out[o + 1] = a[2] + (b[2] - a[2]) * u; out[o + 2] = a[3] + (b[3] - a[3]) * u;
  }
  function chartColor(id, out, o) {
    const h = (id * 137.508) % 360 / 360, s = 0.55, l = 0.62;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    out[o] = f(h + 1 / 3); out[o + 1] = f(h); out[o + 2] = f(h - 1 / 3);
  }

  class Viewport {
    constructor(container) {
      const THREE = root.THREE;
      this.container = container;
      this.listeners = {};
      this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
      if ('outputEncoding' in this.renderer) this.renderer.outputEncoding = THREE.sRGBEncoding;
      container.appendChild(this.renderer.domElement);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
      this.camera.position.set(3, 2, 4);
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.12;
      this.controls.addEventListener('change', () => this.requestRender());
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4250, 0.75));
      const key = new THREE.DirectionalLight(0xffffff, 0.9);
      key.position.set(4, 7, 5);
      this.camera.add(key);
      this.scene.add(this.camera);
      this.mesh = null; this.seamLines = null; this.manualLines = null; this.highlight = null; this.hoverLine = null;
      this.textureMode = 'checker'; this.heatMode = 'none'; this.heatData = null;
      this.model = null; this.result = null; this.baked = null;
      this.showSeams = true; this.wire = false; this.seamTool = false;
      this.setBackground();
      this.raycaster = new THREE.Raycaster();
      this.bindPointer();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
      this.resize();
      this.loop = this.loop.bind(this);
      this.dirty = true;
      requestAnimationFrame(this.loop);
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, payload) { for (const fn of this.listeners[ev] || []) fn(payload); }

    setBackground() {
      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      this.scene.background = new root.THREE.Color(dark ? 0x10151d : 0xe9eef5);
      this.requestRender();
    }

    resize() {
      const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.requestRender();
    }

    requestRender() { this.dirty = true; }
    loop() {
      requestAnimationFrame(this.loop);
      const moved = this.controls.update();
      if (this.dirty || moved || this.controls.autoRotate) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
    }

    /* ---------- model ---------- */
    setModel(model) {
      const THREE = root.THREE;
      if (this.baked) this.baked.dispose();
      for (const m of (this.model && this.model !== model && this.model.materials) || []) if (m.map && m.map.dispose) m.map.dispose();
      this.model = model;
      this.result = null;
      this.baked = null;
      if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); if (this.mesh.material) this.mesh.material.dispose(); }
      this.highlightChart(-1);
      const F = model.positions.length / 9;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(model.normals ? Float32Array.from(model.normals) : smoothNormals(model.positions), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6 * F), 2));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9 * F).fill(1), 3));
      geo.computeBoundingSphere();
      this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
      this.scene.add(this.mesh);
      this.clearLines();
      this.updateMaterial();
      this.frame();
    }

    setResult(result) {
      this.result = result;
      if (!this.mesh) return;
      const uvAttr = this.mesh.geometry.attributes.uv;
      if (result && result.uv && result.uv.length !== uvAttr.array.length) { this.result = null; return; } // result of another mesh
      if (result && result.uv && this.textureMode !== 'original') { uvAttr.array.set(result.uv); uvAttr.needsUpdate = true; }
      this.setSeamSegments(result ? result.seamSegments : null);
      this.updateColors();
      this.updateMaterial();
    }

    setBakedTexture(canvasOrNull) {
      const THREE = root.THREE;
      if (this.baked) this.baked.dispose();
      this.baked = null;
      if (canvasOrNull) {
        this.baked = new THREE.CanvasTexture(canvasOrNull);
        this.baked.flipY = true; // canvas top row = v 1 (three.js image convention)
        if ('encoding' in this.baked) this.baked.encoding = THREE.sRGBEncoding;
        this.baked.anisotropy = 8;
      }
      this.updateMaterial();
    }

    setTextureMode(mode) {
      this.textureMode = mode;
      if (this.mesh) {
        const uvAttr = this.mesh.geometry.attributes.uv;
        const src = mode === 'original' && this.model && this.model.originalUV ? this.model.originalUV : (this.result && this.result.uv);
        if (src) { uvAttr.array.set(src); uvAttr.needsUpdate = true; }
      }
      this.updateColors();
      this.updateMaterial();
    }

    setHeat(mode, perFace) { this.heatMode = mode; this.heatData = perFace || null; this.updateColors(); this.updateMaterial(); }

    updateColors() {
      if (!this.mesh) return;
      const col = this.mesh.geometry.attributes.color, a = col.array, F = a.length / 9;
      const tmp = new Float32Array(3);
      const chart = this.result && this.result.faceChart;
      for (let f = 0; f < F; f++) {
        if (this.heatMode !== 'none' && this.heatData) heatColor(this.heatData[f], tmp, 0);
        else if (this.textureMode === 'charts' && chart) chartColor(chart[f], tmp, 0);
        else { tmp[0] = tmp[1] = tmp[2] = 1; }
        for (let k = 0; k < 3; k++) { a[9 * f + 3 * k] = tmp[0]; a[9 * f + 3 * k + 1] = tmp[1]; a[9 * f + 3 * k + 2] = tmp[2]; }
      }
      col.needsUpdate = true;
      this.requestRender();
    }

    updateMaterial() {
      if (!this.mesh) return;
      const THREE = root.THREE, T = UVApp.textures;
      const heat = this.heatMode !== 'none' && this.heatData;
      let map = null;
      if (!heat) {
        if (this.textureMode === 'checker') map = T.checker(1024, 16);
        else if (this.textureMode === 'colorgrid') map = T.colorGrid(2048);
        else if (this.textureMode === 'baked') map = this.baked;
        else if (this.textureMode === 'original' && this.model) { const m = this.model.materials.find(x => x.map); map = m ? this.originalMap(m.map) : null; }
      }
      const old = this.mesh.material;
      const mat = new THREE.MeshStandardMaterial({
        map, vertexColors: true, roughness: 0.78, metalness: 0.02, side: THREE.DoubleSide, wireframe: this.wire,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        color: (!map && !heat && this.textureMode === 'plain') ? 0x8fb4e8 : 0xffffff
      });
      this.mesh.material = mat;
      if (old) old.dispose();
      this.requestRender();
    }

    /* Original textures are shown with the model's (v-up normalised) uvs: glTF maps
     * (flipY = false) get a v-flip composed with their own texture transform. */
    originalMap(src) {
      if (src.flipY !== false) return src;
      if (this._origMap && this._origMap.src === src) return this._origMap.tex;
      const tex = src.clone();
      src.updateMatrix();
      tex.matrixAutoUpdate = false;
      tex.matrix.copy(src.matrix).multiply(new root.THREE.Matrix3().set(1, 0, 0, 0, -1, 1, 0, 0, 1));
      tex.needsUpdate = true;
      if (this._origMap) this._origMap.tex.dispose();
      this._origMap = { src, tex };
      return tex;
    }

    setWireframe(on) { this.wire = on; this.updateMaterial(); }
    setTurntable(on) { this.controls.autoRotate = on; this.controls.autoRotateSpeed = 1.6; this.requestRender(); }
    setSeamsVisible(on) { this.showSeams = on; if (this.seamLines) this.seamLines.visible = on; if (this.manualLines) this.manualLines.visible = on; this.requestRender(); }

    clearLines() {
      for (const k of ['seamLines', 'manualLines', 'highlight', 'hoverLine']) {
        if (this[k]) { this.scene.remove(this[k]); this[k].geometry.dispose(); this[k].material.dispose(); this[k] = null; }
      }
    }

    makeLines(segments, color, width) {
      const THREE = root.THREE;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(segments), 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: true, linewidth: width || 1 }));
      l.renderOrder = 2;
      return l;
    }

    setSeamSegments(segments) {
      if (this.seamLines) { this.scene.remove(this.seamLines); this.seamLines.geometry.dispose(); this.seamLines.material.dispose(); this.seamLines = null; }
      if (segments && segments.length) { this.seamLines = this.makeLines(segments, 0xffd166); this.seamLines.visible = this.showSeams; this.scene.add(this.seamLines); }
      this.requestRender();
    }

    setManualSeams(segments) {
      if (this.manualLines) { this.scene.remove(this.manualLines); this.manualLines.geometry.dispose(); this.manualLines.material.dispose(); this.manualLines = null; }
      if (segments && segments.length) { this.manualLines = this.makeLines(segments, 0xff4fd8); this.manualLines.visible = this.showSeams; this.scene.add(this.manualLines); }
      this.requestRender();
    }

    highlightChart(id) {
      const THREE = root.THREE;
      if (this.highlight) { this.scene.remove(this.highlight); this.highlight.geometry.dispose(); this.highlight.material.dispose(); this.highlight = null; }
      if (id >= 0 && this.mesh && this.result) {
        const fc = this.result.faceChart, idx = [];
        for (let f = 0; f < fc.length; f++) if (fc[f] === id) idx.push(3 * f, 3 * f + 1, 3 * f + 2);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', this.mesh.geometry.attributes.position);
        g.setIndex(idx);
        this.highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x5aa2ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
        this.highlight.renderOrder = 1;
        this.scene.add(this.highlight);
      }
      this.requestRender();
    }

    frame() {
      if (!this.mesh) return;
      const s = this.mesh.geometry.boundingSphere, THREE = root.THREE;
      const r = Math.max(s.radius, 1e-3), d = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.1;
      const dir = new THREE.Vector3(0.8, 0.55, 1).normalize();
      this.camera.position.copy(s.center).addScaledVector(dir, d);
      this.camera.near = d / 200; this.camera.far = d * 20;
      this.camera.updateProjectionMatrix();
      this.controls.target.copy(s.center);
      this.controls.update();
      this.requestRender();
    }

    screenshot() {
      this.renderer.render(this.scene, this.camera);
      return new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    }

    /* ---------- picking ---------- */
    pick(clientX, clientY) {
      if (!this.mesh) return null;
      const THREE = root.THREE, rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.intersectObject(this.mesh, false)[0];
      if (!hit || hit.faceIndex === undefined) return null;
      const f = hit.faceIndex, P = this.model.positions, p = hit.point;
      let best = 0, bestD = Infinity;
      for (let k = 0; k < 3; k++) {
        const a = 9 * f + 3 * k, b = 9 * f + 3 * ((k + 1) % 3);
        const d = segDist(p.x, p.y, p.z, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]);
        if (d < bestD) { bestD = d; best = k; }
      }
      return { face: f, edge: best, point: [p.x, p.y, p.z], distance: bestD };
    }

    showHoverEdge(face, k) {
      if (this.hoverLine) { this.scene.remove(this.hoverLine); this.hoverLine.geometry.dispose(); this.hoverLine.material.dispose(); this.hoverLine = null; }
      if (face >= 0 && this.model) {
        const P = this.model.positions, a = 9 * face + 3 * k, b = 9 * face + 3 * ((k + 1) % 3);
        this.hoverLine = this.makeLines([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]], 0x3dd6b0);
        this.hoverLine.material.depthTest = false;
        this.scene.add(this.hoverLine);
      }
      this.requestRender();
    }

    setSeamTool(on) {
      this.seamTool = on;
      this.container.classList.toggle('seam-tool', on);
      if (!on) this.showHoverEdge(-1);
    }

    bindPointer() {
      const el = this.renderer.domElement;
      let down = null, last = 0;
      el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
      el.addEventListener('pointerup', (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
        const btn = down.button;
        down = null;
        if (moved || btn !== 0) return;
        const hit = this.pick(e.clientX, e.clientY);
        this.emit('pick', { hit, shift: e.shiftKey, alt: e.altKey, seamTool: this.seamTool });
      });
      el.addEventListener('pointermove', (e) => {
        const now = performance.now();
        if (now - last < 40 || down) return;
        last = now;
        const hit = this.pick(e.clientX, e.clientY);
        if (this.seamTool) this.showHoverEdge(hit ? hit.face : -1, hit ? hit.edge : 0);
        this.emit('hover', hit);
      });
      el.addEventListener('pointerleave', () => { if (this.seamTool) this.showHoverEdge(-1); this.emit('hover', null); });
    }
  }

  function segDist(px, py, pz, ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy, pz - az - t * dz);
  }

  /* Smooth per-corner normals by welding positions (the soup has no shared vertices). */
  function smoothNormals(P) {
    const F = P.length / 9, n = new Float32Array(P.length), map = new Map(), acc = [];
    const key = (i) => P[i].toFixed(5) + ',' + P[i + 1].toFixed(5) + ',' + P[i + 2].toFixed(5);
    const ids = new Int32Array(3 * F);
    for (let c = 0; c < 3 * F; c++) {
      const k = key(3 * c);
      let id = map.get(k);
      if (id === undefined) { id = acc.length / 3; map.set(k, id); acc.push(0, 0, 0); }
      ids[c] = id;
    }
    for (let f = 0; f < F; f++) {
      const i = 9 * f;
      const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
      const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) { const id = ids[3 * f + k] * 3; acc[id] += cx; acc[id + 1] += cy; acc[id + 2] += cz; }
    }
    for (let c = 0; c < 3 * F; c++) {
      const id = ids[c] * 3, l = Math.hypot(acc[id], acc[id + 1], acc[id + 2]) || 1;
      n[3 * c] = acc[id] / l; n[3 * c + 1] = acc[id + 1] / l; n[3 * c + 2] = acc[id + 2] / l;
    }
    return n;
  }

  UVApp.Viewport = Viewport;
  UVApp.colors = { heatColor, chartColor };
})(typeof window !== 'undefined' ? window : globalThis);
