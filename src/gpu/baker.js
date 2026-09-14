/* GPU UV-space baking (WebGL via three.js r141).
 *
 * UVApp.baker = {
 *   transfer(renderer, { positions, newUV, oldUV, faceMaterial, materials, size, supersample }) -> HTMLCanvasElement
 *       Re-bakes a model's existing texture(s) onto a new UV layout: every triangle is rasterised at
 *       its NEW uv (clip = uv*2-1) and samples the ORIGINAL texture at its OLD uv. Supersampled, then
 *       gutters are filled with pull-push so mip levels never bleed background into charts.
 *   maps(renderer, { positions, normals, newUV, faceChart, size }) -> { position, normal, chartId, mask } canvases
 *       UV-space G-buffer maps for texturing / AI pipelines (object-space position & normal, chart ids, coverage).
 *   pullPush(rgba, w, h) -> fills transparent texels in place
 * }
 * Texture bytes are sampled raw (the bake texture is re-uploaded with linear encoding), so sRGB data
 * is copied without double conversion.
 */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};

  const VS = `
    attribute vec2 aTarget;
    attribute vec2 aSrc;
    attribute vec3 aPos;
    attribute vec3 aNrm;
    attribute vec3 aCol;
    varying vec2 vSrc; varying vec3 vPos; varying vec3 vNrm; varying vec3 vCol;
    void main() {
      vSrc = aSrc; vPos = aPos; vNrm = aNrm; vCol = aCol;
      gl_Position = vec4(aTarget * 2.0 - 1.0, 0.0, 1.0);
    }`;
  const FS_TRANSFER = `
    precision highp float;
    uniform sampler2D map; uniform vec3 color; uniform float hasMap;
    varying vec2 vSrc;
    void main() {
      vec4 t = hasMap > 0.5 ? texture2D(map, vSrc) : vec4(color, 1.0);
      gl_FragColor = vec4(t.rgb, 1.0);
    }`;
  const FS_MAP = `
    precision highp float;
    uniform int kind; uniform vec3 bmin; uniform vec3 bsize;
    varying vec3 vPos; varying vec3 vNrm; varying vec3 vCol;
    void main() {
      if (kind == 0) gl_FragColor = vec4((vPos - bmin) / bsize, 1.0);
      else if (kind == 1) gl_FragColor = vec4(normalize(vNrm) * 0.5 + 0.5, 1.0);
      else if (kind == 2) gl_FragColor = vec4(vCol, 1.0);
      else gl_FragColor = vec4(1.0);
    }`;

  function clampSize(renderer, size) {
    const max = renderer.capabilities && renderer.capabilities.maxTextureSize ? renderer.capabilities.maxTextureSize : 4096;
    return Math.min(size, max);
  }

  function renderToPixels(renderer, scene, W, H) {
    const THREE = root.THREE;
    const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear(true, true, true);
    renderer.render(scene, cam);
    const px = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    rt.dispose();
    return px;
  }

  /* Box downsample by an integer factor, alpha-weighted (coverage-correct edges). */
  function downsample(src, W, H, k) {
    const w = Math.floor(W / k), h = Math.floor(H / k), out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
          const p = ((y * k + j) * W + x * k + i) * 4, al = src[p + 3];
          r += src[p] * al; g += src[p + 1] * al; b += src[p + 2] * al; a += al;
        }
        const o = (y * w + x) * 4;
        if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = a / (k * k) > 0 ? 255 : 0; }
      }
    }
    return { data: out, w, h };
  }

  /* Pull-push hole filling: coarser averages of covered texels flow into empty texels. */
  function pullPush(rgba, w, h) {
    const levels = [];
    let cw = w, ch = h;
    let col = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { if (rgba[4 * i + 3] > 0) { wt[i] = 1; col[3 * i] = rgba[4 * i]; col[3 * i + 1] = rgba[4 * i + 1]; col[3 * i + 2] = rgba[4 * i + 2]; } }
    levels.push({ col, wt, w: cw, h: ch });
    while (cw > 1 || ch > 1) {
      const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1), prev = levels[levels.length - 1];
      const ncol = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const i = y * cw + x, wi = prev.wt[i];
        if (!wi) continue;
        const j = Math.min(nh - 1, y >> 1) * nw + Math.min(nw - 1, x >> 1);
        nwt[j] += wi; ncol[3 * j] += prev.col[3 * i] * wi; ncol[3 * j + 1] += prev.col[3 * i + 1] * wi; ncol[3 * j + 2] += prev.col[3 * i + 2] * wi;
      }
      for (let j = 0; j < nw * nh; j++) if (nwt[j] > 0) { ncol[3 * j] /= nwt[j]; ncol[3 * j + 1] /= nwt[j]; ncol[3 * j + 2] /= nwt[j]; nwt[j] = 1; }
      levels.push({ col: ncol, wt: nwt, w: nw, h: nh });
      cw = nw; ch = nh;
    }
    for (let l = levels.length - 2; l >= 0; l--) {
      const fine = levels[l], coarse = levels[l + 1];
      for (let y = 0; y < fine.h; y++) for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        if (fine.wt[i]) continue;
        const j = Math.min(coarse.h - 1, y >> 1) * coarse.w + Math.min(coarse.w - 1, x >> 1);
        if (!coarse.wt[j]) continue;
        fine.col[3 * i] = coarse.col[3 * j]; fine.col[3 * i + 1] = coarse.col[3 * j + 1]; fine.col[3 * i + 2] = coarse.col[3 * j + 2]; fine.wt[i] = 1;
      }
    }
    const base = levels[0];
    for (let i = 0; i < w * h; i++) {
      if (rgba[4 * i + 3] > 0) continue;
      rgba[4 * i] = base.col[3 * i]; rgba[4 * i + 1] = base.col[3 * i + 1]; rgba[4 * i + 2] = base.col[3 * i + 2]; rgba[4 * i + 3] = 255;
    }
    return rgba;
  }

  function toCanvas(rgba, w, h, flipRows) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    // GL rows start at the bottom (v = 0); canvas rows start at the top.
    for (let y = 0; y < h; y++) {
      const src = flipRows ? (h - 1 - y) * w * 4 : y * w * 4;
      img.data.set(rgba.subarray(src, src + w * 4), y * w * 4);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function buildGeometry(positions, newUV, extra) {
    const THREE = root.THREE, F = positions.length / 9;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * F), 3)); // unused, keeps three happy
    geo.setAttribute('aTarget', new THREE.BufferAttribute(Float32Array.from(newUV), 2));
    for (const k of Object.keys(extra)) geo.setAttribute(k, new THREE.BufferAttribute(extra[k].array, extra[k].size));
    return geo;
  }

  function transfer(renderer, opts) {
    const THREE = root.THREE;
    const size = clampSize(renderer, opts.size || 2048);
    const ss = Math.max(1, Math.min(opts.supersample || 2, Math.floor(clampSize(renderer, size * 2) / size)));
    const W = size * ss;
    const F = opts.positions.length / 9;
    const geo = buildGeometry(opts.positions, opts.newUV, { aSrc: { array: Float32Array.from(opts.oldUV), size: 2 } });
    const mats = (opts.materials && opts.materials.length ? opts.materials : [{ color: [0.8, 0.8, 0.8], map: null }]).map(m => {
      let map = null;
      if (m.map && m.map.image) {
        map = new THREE.Texture(m.map.image);
        map.flipY = m.map.flipY; map.wrapS = m.map.wrapS; map.wrapT = m.map.wrapT;
        map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
        map.needsUpdate = true;
      }
      return new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS_TRANSFER, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
        uniforms: { map: { value: map }, hasMap: { value: map ? 1 : 0 }, color: { value: new THREE.Color().fromArray(m.color || [0.8, 0.8, 0.8]) } } });
    });
    if (opts.faceMaterial && mats.length > 1) {
      let start = 0;
      for (let f = 1; f <= F; f++) {
        if (f === F || opts.faceMaterial[f] !== opts.faceMaterial[start]) { geo.addGroup(3 * start, 3 * (f - start), opts.faceMaterial[start]); start = f; }
      }
    }
    const mesh = new THREE.Mesh(geo, mats.length > 1 && opts.faceMaterial ? mats : mats[0]);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const px = renderToPixels(renderer, scene, W, W);
    geo.dispose();
    for (const m of mats) { if (m.uniforms.map.value) m.uniforms.map.value.dispose(); m.dispose(); }
    const ds = ss > 1 ? downsample(px, W, W, ss) : { data: new Uint8ClampedArray(px.buffer), w: W, h: W };
    pullPush(ds.data, ds.w, ds.h);
    return toCanvas(ds.data, ds.w, ds.h, true);
  }

  function maps(renderer, opts) {
    const THREE = root.THREE;
    const size = clampSize(renderer, opts.size || 2048);
    const P = opts.positions, F = P.length / 9;
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { if (P[i + a] < min[a]) min[a] = P[i + a]; if (P[i + a] > max[a]) max[a] = P[i + a]; }
    const bsize = max.map((v, a) => Math.max(1e-9, v - min[a]));
    let N = opts.normals;
    if (!N) {
      N = new Float32Array(P.length);
      for (let f = 0; f < F; f++) {
        const i = 9 * f;
        const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2], vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
        let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        const l = Math.hypot(cx, cy, cz) || 1; cx /= l; cy /= l; cz /= l;
        for (let k = 0; k < 3; k++) { N[i + 3 * k] = cx; N[i + 3 * k + 1] = cy; N[i + 3 * k + 2] = cz; }
      }
    }
    const col = new Float32Array(9 * F), tmp = new Float32Array(3);
    for (let f = 0; f < F; f++) {
      UVApp.colors.chartColor(opts.faceChart ? opts.faceChart[f] : 0, tmp, 0);
      for (let k = 0; k < 3; k++) col.set(tmp, 9 * f + 3 * k);
    }
    const geo = buildGeometry(P, opts.newUV, { aPos: { array: Float32Array.from(P), size: 3 }, aNrm: { array: Float32Array.from(N), size: 3 }, aCol: { array: col, size: 3 } });
    const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS_MAP, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      uniforms: { kind: { value: 0 }, bmin: { value: new THREE.Vector3().fromArray(min) }, bsize: { value: new THREE.Vector3().fromArray(bsize) } } });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const out = {};
    ['position', 'normal', 'chartId', 'mask'].forEach((name, kind) => {
      mat.uniforms.kind.value = kind;
      const px = renderToPixels(renderer, scene, size, size);
      const data = new Uint8ClampedArray(px.buffer);
      if (name === 'position' || name === 'normal') pullPush(data, size, size);
      out[name] = toCanvas(data, size, size, true);
    });
    geo.dispose(); mat.dispose();
    out.bbox = { min, max };
    return out;
  }

  UVApp.baker = { transfer, maps, pullPush };
})(typeof window !== 'undefined' ? window : globalThis);
