/* Model loading: OBJ (+MTL), glTF, GLB, STL, PLY -> merged non-indexed triangle soup.
 * Classic script (file:// safe). Uses the vendored THREE r141 example loaders.
 *
 * UVApp.loaders = {
 *   supportedExtensions,
 *   loadFile(file, opts?) -> Promise<ModelData>
 *   loadFiles(files, opts?) -> Promise<ModelData>      multi-file drops (.gltf + .bin + images, .obj + .mtl + images)
 *   parseBuffer(data, name, format, opts?) -> Promise<ModelData>
 *   fromObject3D(object3D, name, format, opts?) -> ModelData
 *   detectFormat(name, arrayBuffer?) -> format | null
 * }
 * All UVs are normalised to the v-up convention used by OBJ and the kernel (glTF TEXCOORD v is flipped on load);
 * materials record the colour space of their factor (glTF factors are linear, MTL Kd is treated as sRGB).
 * ModelData = { positions: Float32Array(9F), normals: Float32Array(9F)|null, originalUV: Float32Array(6F)|null,
 *               faceMaterial: Uint16Array(F)|null, materials: [{ name, color:[r,g,b], map: THREE.Texture|null }],
 *               name, format, meshCount, faceCount, droppedDegenerate, bbox: {min,max}, warnings: string[] }
 */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};
  const supportedExtensions = ['obj', 'gltf', 'glb', 'stl', 'ply'];
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ktx2', 'basis'];

  const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
  /* File name of a path/URL. Decoding is best-effort: MTL/OBJ paths are plain paths and may contain '%'. */
  const rawBaseName = (url) => String(url).split(/[\\/]/).pop().split('?')[0];
  const baseName = (url) => { const raw = rawBaseName(url); try { return decodeURIComponent(raw); } catch (e) { return raw; } };
  /* MTL texture statement: skip option flags and keep the (possibly space-containing) file name. */
  const MTL_OPTION_ARGS = { '-blendu': 1, '-blendv': 1, '-cc': 1, '-clamp': 1, '-bm': 1, '-boost': 1, '-imfchan': 1, '-type': 1, '-texres': 1, '-mm': 2, '-o': 3, '-s': 3, '-t': 3 };
  function mtlMapPath(parts) {
    let i = 1;
    while (i < parts.length && MTL_OPTION_ARGS[parts[i].toLowerCase()] !== undefined) {
      const n = MTL_OPTION_ARGS[parts[i].toLowerCase()];
      i++;
      let taken = 0;
      while (taken < n && i < parts.length && /^-?\d*\.?\d+(e-?\d+)?$|^(on|off)$/i.test(parts[i])) { i++; taken++; }
    }
    return parts.slice(i).join(' ');
  }

  function detectFormat(name, buffer) {
    const ext = extOf(name);
    if (supportedExtensions.indexOf(ext) >= 0) return ext;
    if (buffer && buffer.byteLength >= 4) {
      const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 512));
      const head = String.fromCharCode.apply(null, b.subarray(0, Math.min(80, b.length)));
      if (head.slice(0, 4) === 'glTF') return 'glb';
      if (head.slice(0, 3) === 'ply') return 'ply';
      if (/^\s*\{/.test(head) && /"asset"/.test(String.fromCharCode.apply(null, b))) return 'gltf';
      if (buffer.byteLength >= 84) {
        const n = new DataView(buffer).getUint32(80, true);
        if (84 + n * 50 === buffer.byteLength) return 'stl';
      }
      if (/^\s*solid/.test(head)) return 'stl';
      if (/^\s*(#|v |o |g |mtllib)/m.test(head)) return 'obj';
    }
    return null;
  }

  function readAs(file, kind) {
    if (kind === 'text' && file.text) return file.text();
    if (kind !== 'text' && file.arrayBuffer) return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Could not read ' + file.name));
      if (kind === 'text') r.readAsText(file); else r.readAsArrayBuffer(file);
    });
  }

  /* Minimal MTL parser (MTLLoader is not vendored): Kd colour and map_Kd. */
  function parseMTL(text) {
    const out = {};
    let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/), key = parts[0].toLowerCase();
      if (key === 'newmtl') { cur = out[parts.slice(1).join(' ')] = { color: [0.8, 0.8, 0.8], map: null }; }
      else if (!cur) continue;
      else if (key === 'kd' && parts.length >= 4) cur.color = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
      else if (key === 'map_kd') { const path = mtlMapPath(parts); if (path) cur.map = path; }
    }
    return out;
  }

  function loadTexture(url) {
    return new Promise((resolve) => {
      if (!url || typeof document === 'undefined') { resolve(null); return; }
      new THREE.TextureLoader().load(url, (t) => {
        t.flipY = true;
        t.wrapS = t.wrapT = THREE.RepeatWrapping; // OBJ/MTL textures tile by default
        if ('encoding' in t) t.encoding = THREE.sRGBEncoding;
        resolve(t);
      }, undefined, () => resolve(null));
    });
  }

  async function loadFiles(files, opts) {
    opts = opts || {};
    const list = Array.from(files || []);
    if (!list.length) throw new Error('No file selected.');
    const byName = new Map(list.map(f => [f.name, f]));
    const priority = ['glb', 'gltf', 'obj', 'ply', 'stl'];
    let main = null;
    for (const ext of priority) { main = list.find(f => extOf(f.name) === ext); if (main) break; }
    if (!main) {
      for (const f of list) {
        const buf = await readAs(f, 'buffer');
        if (detectFormat(f.name, buf)) { main = f; break; }
      }
    }
    if (!main) throw new Error('Unsupported file type. Supported: ' + supportedExtensions.map(e => '.' + e).join(', ') + '.');
    const urls = new Map();
    const urlFor = (name) => {
      const f = byName.get(name) || list.find(x => x.name.toLowerCase() === String(name).toLowerCase());
      if (!f) return null;
      if (!urls.has(f.name)) urls.set(f.name, URL.createObjectURL(f));
      return urls.get(f.name);
    };
    try {
      const buf = await readAs(main, 'buffer');
      const format = detectFormat(main.name, buf);
      return await parseBuffer(buf, main.name, format, Object.assign({}, opts, {
        resolveURL: (u) => urlFor(rawBaseName(u)) || urlFor(baseName(u)),
        sidecarText: async (name) => { const f = byName.get(name) || list.find(x => x.name.toLowerCase() === String(name).toLowerCase()); return f ? readAs(f, 'text') : null; }
      }));
    } finally {
      // textures load asynchronously from blob URLs; revoke after they had time to decode
      setTimeout(() => { for (const u of urls.values()) URL.revokeObjectURL(u); }, 30000);
    }
  }

  function loadFile(file, opts) { return loadFiles([file], opts); }

  async function parseBuffer(data, name, format, opts) {
    opts = opts || {};
    format = format || detectFormat(name, data instanceof ArrayBuffer ? data : null);
    if (!format) throw new Error('Unsupported file type: ' + name);
    const THREE = root.THREE;
    if (!THREE) throw new Error('three.js is not loaded.');
    const textOf = (d) => typeof d === 'string' ? d : new TextDecoder().decode(new Uint8Array(d));
    let object;
    if (format === 'obj') {
      if (!THREE.OBJLoader) throw new Error('OBJLoader missing.');
      const text = textOf(data);
      object = new THREE.OBJLoader().parse(text);
      const mtlName = /^\s*mtllib\s+(.+)$/m.exec(text);
      if (mtlName && opts.sidecarText) {
        const mtlText = await opts.sidecarText(rawBaseName(mtlName[1].trim()));
        if (mtlText) {
          const mtl = parseMTL(mtlText);
          const pending = [];
          object.traverse((o) => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              const def = m && mtl[m.name];
              if (!def) continue;
              m.color && m.color.setRGB(def.color[0], def.color[1], def.color[2]);
              if (def.map && opts.resolveURL) pending.push(loadTexture(opts.resolveURL(rawBaseName(def.map))).then(t => { if (t) { m.map = t; m.needsUpdate = true; } }));
            }
          });
          await Promise.all(pending);
        }
      }
    } else if (format === 'stl') {
      if (!THREE.STLLoader) throw new Error('STLLoader missing.');
      const geom = new THREE.STLLoader().parse(data);
      object = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
    } else if (format === 'ply') {
      if (!THREE.PLYLoader) throw new Error('PLYLoader missing.');
      const geom = new THREE.PLYLoader().parse(data);
      if (!geom.index && geom.attributes.position && (geom.attributes.position.count % 3 !== 0 || !opts.plyAllowSoup)) {
        throw new Error(name + ' has no faces (point cloud). Only triangle meshes can be unwrapped.');
      }
      object = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
    } else {
      if (!THREE.GLTFLoader) throw new Error('GLTFLoader missing.');
      const loader = new THREE.GLTFLoader();
      if (opts.resolveURL && THREE.LoadingManager) {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((u) => (/^(data|blob):/.test(u) ? u : (opts.resolveURL(u) || u)));
        loader.manager = manager;
      }
      const payload = format === 'gltf' ? textOf(data) : data;
      const gltf = await new Promise((resolve, reject) => loader.parse(payload, '', resolve, (e) => reject(new Error('glTF parse failed: ' + (e && e.message ? e.message : e)))));
      object = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    }
    const model = fromObject3D(object, name, format, opts);
    return model;
  }

  function fromObject3D(object, name, format, opts) {
    opts = opts || {};
    const THREE = root.THREE;
    const warnings = [];
    object.updateMatrixWorld(true);
    const meshes = [];
    object.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) meshes.push(o); });
    if (!meshes.length) throw new Error('No triangle meshes found in ' + name + '.');
    // count triangles
    let total = 0;
    for (const o of meshes) {
      const g = o.geometry, n = g.index ? g.index.count : g.attributes.position.count;
      total += Math.floor(n / 3);
    }
    if (opts.maxFaces && total > opts.maxFaces) throw new Error(name + ' has ' + total.toLocaleString() + ' triangles; the limit is ' + opts.maxFaces.toLocaleString() + '. Decimate it first.');
    const allHaveUV = meshes.every(o => !!o.geometry.attributes.uv);
    if (!allHaveUV && meshes.some(o => !!o.geometry.attributes.uv)) warnings.push('Some meshes have no UVs: original UVs were ignored.');
    const P = new Float32Array(9 * total), N = new Float32Array(9 * total);
    const U = allHaveUV ? new Float32Array(6 * total) : null;
    const FM = new Uint16Array(total);
    const materials = [], matIndex = new Map();
    const matId = (m) => {
      if (!m) m = { uuid: '__default', name: 'default' };
      if (matIndex.has(m.uuid)) return matIndex.get(m.uuid);
      const id = materials.length;
      matIndex.set(m.uuid, id);
      materials.push({ name: m.name || ('material_' + id), color: m.color ? [m.color.r, m.color.g, m.color.b] : [0.8, 0.8, 0.8], colorSpace: gltf ? 'linear' : 'srgb', map: m.map || null });
      return id;
    };
    let f = 0;
    let hasNormals = true;
    const gltf = format === 'gltf' || format === 'glb';
    // normalized integer attributes (KHR_mesh_quantization): three r141 getX() returns raw integers
    const comp = (attr, vi, c) => {
      const v = c === 0 ? attr.getX(vi) : c === 1 ? attr.getY(vi) : attr.getZ(vi);
      if (!attr.normalized) return v;
      const arr = attr.isInterleavedBufferAttribute ? attr.data.array : attr.array;
      if (arr instanceof Uint8Array || arr instanceof Uint8ClampedArray) return v / 255;
      if (arr instanceof Uint16Array) return v / 65535;
      if (arr instanceof Uint32Array) return v / 4294967295;
      if (arr instanceof Int8Array) return Math.max(v / 127, -1);
      if (arr instanceof Int16Array) return Math.max(v / 32767, -1);
      if (arr instanceof Int32Array) return Math.max(v / 2147483647, -1);
      return v;
    };
    const nm = new THREE.Matrix3();
    for (const o of meshes) {
      const g = o.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, idx = g.index;
      if (!nor) hasNormals = false;
      const e = o.matrixWorld.elements;
      nm.getNormalMatrix(o.matrixWorld);
      const n = nm.elements;
      const flip = o.matrixWorld.determinant() < 0;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const groups = g.groups && g.groups.length ? g.groups : null;
      const count = Math.floor((idx ? idx.count : pos.count) / 3);
      for (let t = 0; t < count; t++) {
        let mi = 0;
        if (groups) {
          const start = 3 * t;
          for (const gr of groups) if (start >= gr.start && start < gr.start + gr.count) { mi = gr.materialIndex || 0; break; }
        }
        FM[f] = matId(mats[mi] || mats[0]);
        for (let k = 0; k < 3; k++) {
          const kk = flip && k > 0 ? 3 - k : k;          // swap corners 1 and 2 under mirroring
          const vi = idx ? idx.getX(3 * t + kk) : 3 * t + kk;
          const x = comp(pos, vi, 0), y = comp(pos, vi, 1), z = comp(pos, vi, 2);
          const o9 = 9 * f + 3 * k;
          P[o9] = e[0] * x + e[4] * y + e[8] * z + e[12];
          P[o9 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          P[o9 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
          if (nor) {
            const nx = comp(nor, vi, 0), ny = comp(nor, vi, 1), nz = comp(nor, vi, 2);
            let ax = n[0] * nx + n[3] * ny + n[6] * nz, ay = n[1] * nx + n[4] * ny + n[7] * nz, az = n[2] * nx + n[5] * ny + n[8] * nz;
            const l = Math.hypot(ax, ay, az) || 1;
            N[o9] = ax / l; N[o9 + 1] = ay / l; N[o9 + 2] = az / l;
          }
          if (U) { U[6 * f + 2 * k] = comp(uv, vi, 0); const v = comp(uv, vi, 1); U[6 * f + 2 * k + 1] = gltf ? 1 - v : v; }
        }
        f++;
      }
    }
    // bbox and degenerate filtering
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 9 * total; i += 3) {
      for (let a = 0; a < 3; a++) { const v = P[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
    }
    const diag2 = (max[0] - min[0]) ** 2 + (max[1] - min[1]) ** 2 + (max[2] - min[2]) ** 2;
    const eps = 1e-24 * Math.max(diag2 * diag2, 1e-30); // (area ≤ 1e-12·diag²)² compared with |cross|²/4
    let keep = 0;
    const keepMask = new Uint8Array(total);
    for (let t = 0; t < total; t++) {
      const i = 9 * t;
      const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
      const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const a2 = (cx * cx + cy * cy + cz * cz) / 4;
      if (a2 > eps && Number.isFinite(a2)) { keepMask[t] = 1; keep++; }
    }
    const dropped = total - keep;
    let positions = P, normals = hasNormals ? N : null, originalUV = U, faceMaterial = FM;
    if (dropped) {
      positions = new Float32Array(9 * keep); normals = hasNormals ? new Float32Array(9 * keep) : null;
      originalUV = U ? new Float32Array(6 * keep) : null; faceMaterial = new Uint16Array(keep);
      let o = 0;
      for (let t = 0; t < total; t++) {
        if (!keepMask[t]) continue;
        positions.set(P.subarray(9 * t, 9 * t + 9), 9 * o);
        if (normals) normals.set(N.subarray(9 * t, 9 * t + 9), 9 * o);
        if (originalUV) originalUV.set(U.subarray(6 * t, 6 * t + 6), 6 * o);
        faceMaterial[o] = FM[t];
        o++;
      }
      warnings.push('Dropped ' + dropped + ' degenerate triangle(s).');
    }
    if (!keep) throw new Error(name + ' contains only degenerate triangles.');
    if (meshes.length > 1) warnings.push('Merged ' + meshes.length + ' meshes.');
    return {
      positions, normals, originalUV, faceMaterial: materials.length > 1 ? faceMaterial : null, materials,
      name: name || 'model', format: format || 'object', meshCount: meshes.length, faceCount: keep,
      droppedDegenerate: dropped, bbox: { min, max }, warnings
    };
  }

  UVApp.loaders = { supportedExtensions, loadFile, loadFiles, parseBuffer, fromObject3D, detectFormat, parseMTL, imageExtensions: IMAGE_EXT };
})(typeof window !== 'undefined' ? window : globalThis);
