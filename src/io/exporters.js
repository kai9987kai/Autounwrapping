/* Exporters: OBJ/MTL, GLB, UV layout PNG, JSON report, CSV, project files, ZIP bundles.
 * Classic script (file:// safe). Canvas / DOM are only touched inside functions.
 */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};
  const TOOL = 'Advanced 3D UV Toolkit v4';

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  const fmt = (v) => { const s = v.toFixed(6); return s === '-0.000000' ? '0.000000' : s; };
  const safeName = (s) => String(s || 'model').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_') || 'model';

  /* OBJ with welded positions (exact float key), deduplicated vt / vn, usemtl groups. */
  function exportOBJText(positions, uv, name, opts) {
    opts = opts || {};
    const F = positions.length / 9;
    const out = [], vKey = new Map(), tKey = new Map(), nKey = new Map();
    const vLines = [], tLines = [], nLines = [], fLines = [];
    const idx = (map, lines, key, line) => { let i = map.get(key); if (i === undefined) { i = lines.length + 1; map.set(key, i); lines.push(line); } return i; };
    let lastMat = -1;
    for (let f = 0; f < F; f++) {
      if (opts.faceMaterial && opts.materialNames) {
        const m = opts.faceMaterial[f];
        if (m !== lastMat) { fLines.push('usemtl ' + (opts.materialNames[m] || 'material_' + m)); lastMat = m; }
      }
      const parts = [];
      for (let k = 0; k < 3; k++) {
        const c = 3 * f + k;
        const px = fmt(positions[3 * c]), py = fmt(positions[3 * c + 1]), pz = fmt(positions[3 * c + 2]);
        const vi = idx(vKey, vLines, px + ' ' + py + ' ' + pz, 'v ' + px + ' ' + py + ' ' + pz);
        let token = String(vi);
        if (uv) {
          const u = fmt(uv[2 * c]), v = fmt(uv[2 * c + 1]);
          token += '/' + idx(tKey, tLines, u + ' ' + v, 'vt ' + u + ' ' + v);
        }
        if (opts.normals) {
          const nx = fmt(opts.normals[3 * c]), ny = fmt(opts.normals[3 * c + 1]), nz = fmt(opts.normals[3 * c + 2]);
          token += (uv ? '/' : '//') + idx(nKey, nLines, nx + ' ' + ny + ' ' + nz, 'vn ' + nx + ' ' + ny + ' ' + nz);
        }
        parts.push(token);
      }
      fLines.push('f ' + parts.join(' '));
    }
    out.push('# ' + TOOL, '# ' + F + ' triangles, ' + vLines.length + ' vertices, ' + tLines.length + ' uvs');
    if (opts.mtlFileName) out.push('mtllib ' + opts.mtlFileName);
    out.push('o ' + safeName(name));
    return out.concat(vLines, tLines, nLines, fLines).join('\n') + '\n';
  }
  function exportOBJ(positions, uv, name, opts) { return new Blob([exportOBJText(positions, uv, name, opts)], { type: 'text/plain' }); }

  function exportMTL(materials) {
    const lines = ['# ' + TOOL];
    for (const m of materials) {
      const c = m.color || [0.8, 0.8, 0.8];
      lines.push('', 'newmtl ' + m.name, 'Kd ' + c.map(v => v.toFixed(4)).join(' '), 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
      if (m.mapFileName) lines.push('map_Kd ' + m.mapFileName);
    }
    return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  }

  function exportGLB(positions, uv, name, opts) {
    opts = opts || {};
    const THREE = root.THREE;
    return new Promise((resolve, reject) => {
      if (!THREE || !THREE.GLTFExporter) { reject(new Error('GLTFExporter is not loaded.')); return; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3));
      if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uv), 2));
      if (opts.normals) geo.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(opts.normals), 3));
      else geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
      if (opts.texture) {
        const tex = opts.texture.isTexture ? opts.texture : new THREE.CanvasTexture(opts.texture);
        // canvas top row = v 1: keep flipY so GLTFExporter flips the image into glTF's v-down convention
        if (!opts.texture.isTexture) tex.flipY = true;
        if ('encoding' in tex) tex.encoding = THREE.sRGBEncoding;
        mat.map = tex;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = safeName(name);
      new THREE.GLTFExporter().parse(mesh, (result) => resolve(new Blob([result], { type: 'model/gltf-binary' })), (e) => reject(e instanceof Error ? e : new Error(String(e))), { binary: true, onlyVisible: false });
    });
  }

  /* ---------------- UV layout drawing ---------------- */
  function hueColor(id, alpha) { return 'hsla(' + ((id * 137.508) % 360).toFixed(1) + ', 72%, 58%, ' + alpha + ')'; }

  /* Draws the layout into any 2D context of size (size x size), v up. */
  function drawUVLayout(ctx, { uv, faceChart, metrics, size, style = 'wire', lineWidth, background = 'transparent' }) {
    const F = uv.length / 6;
    if (background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, size, size); }
    else if (ctx.clearRect) ctx.clearRect(0, 0, size, size);
    ctx.lineWidth = lineWidth || Math.max(1, size / 1024);
    ctx.lineJoin = 'round';
    const heat = metrics && metrics.faceSD;
    for (let f = 0; f < F; f++) {
      const i = 6 * f;
      ctx.beginPath();
      ctx.moveTo(uv[i] * size, (1 - uv[i + 1]) * size);
      ctx.lineTo(uv[i + 2] * size, (1 - uv[i + 3]) * size);
      ctx.lineTo(uv[i + 4] * size, (1 - uv[i + 5]) * size);
      ctx.closePath();
      if (style === 'chart' || style === 'islands-id') {
        ctx.fillStyle = hueColor(faceChart ? faceChart[f] : 0, style === 'islands-id' ? 1 : 0.35);
        ctx.fill();
      } else if (style === 'heat' && heat) {
        const v = heat[f], t = !isFinite(v) ? 1 : Math.min(1, Math.max(0, Math.log(Math.max(1, v)) / Math.log(2)));
        ctx.fillStyle = 'hsl(' + (240 - 240 * t).toFixed(0) + ', 90%, 55%)';
        ctx.fill();
      } else if (style === 'checker') {
        ctx.fillStyle = ((faceChart ? faceChart[f] : 0) % 2) ? 'rgba(40,40,40,0.9)' : 'rgba(220,220,220,0.9)';
        ctx.fill();
      }
      if (style !== 'islands-id') { ctx.strokeStyle = style === 'wire' ? 'rgba(10,20,40,0.9)' : 'rgba(0,0,0,0.35)'; ctx.stroke(); }
    }
  }

  function makeCanvas(size) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }
  function canvasToBlob(canvas, type) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: type || 'image/png' });
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas export failed')), type || 'image/png'));
  }
  async function exportUVPNG(opts) {
    const size = opts.size || 2048;
    const canvas = makeCanvas(size);
    drawUVLayout(canvas.getContext('2d'), Object.assign({}, opts, { size }));
    return canvasToBlob(canvas);
  }

  /* ---------------- reports & data ---------------- */
  function stripTyped(value, depth) {
    depth = depth || 0;
    if (value === null || typeof value !== 'object') return typeof value === 'number' && !isFinite(value) ? String(value) : value;
    if (ArrayBuffer.isView(value)) return value.length <= 16 ? Array.from(value) : { typedArray: value.constructor.name, length: value.length };
    if (depth > 8) return '[depth limit]';
    if (Array.isArray(value)) return value.map(v => stripTyped(v, depth + 1));
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripTyped(value[k], depth + 1);
    return out;
  }

  function exportReport(state) {
    const m = state.metrics || (state.result && state.result.metrics) || null;
    const payload = {
      tool: TOOL, generatedAt: new Date().toISOString(),
      model: state.model || null, meshInfo: state.meshInfo || null, settings: state.settings || null,
      summary: m ? stripTyped({
        score: m.score ? m.score.score : null, preset: m.preset, valid: m.score ? m.score.valid : null,
        charts: m.chartCount, faces: m.faces, stretchL2: m.stretchL2, stretchLinf: m.stretchLinf,
        symmetricDirichlet: { mean: m.sdMean, p99: m.sdP99, chartOptimal: m.sdChartOpt },
        angleErrorDeg: { mean: m.angleMeanDeg, p95: m.angleP95Deg }, areaLog2Mean: m.areaLog2Mean,
        flipped: m.flipped, overlapTexels: m.overlapTexels, outOfRange: m.outOfRange,
        seamLength3D: m.seamLength3D, visibleSeamLength: m.visibleSeamLength,
        texelDensity: m.texelDensity, efficiency: m.efficiency, bake: m.bake,
        improvements: m.score ? m.score.explanations : []
      }) : null,
      metrics: m ? stripTyped(Object.assign({}, m, { faceFlag: undefined, faceL2: undefined, faceSD: undefined, faceAreaLog2: undefined, cornerAngleErr: undefined, seamSegments: undefined })) : null,
      perChart: m ? stripTyped(m.perChart) : null,
      pipeline: state.result ? { notes: state.result.notes, timings: state.result.timings, packing: stripTyped(state.result.packing) } : null,
      history: stripTyped(state.history || []),
      methods: {
        segmentation: 'xatlas-style simultaneous chart growth with Lloyd re-seeding (normal, roundness, straightness, seam costs); optional Seamster visibility-weighted seams (Sheffer & Hart 2002)',
        topology: 'Cut-to-disk: shortest seam paths between boundary loops, farthest-point bisection of closed / high-genus charts; self-overlapping charts are split',
        flattening: 'Boundary First Flattening (Sawhney & Crane 2017) with LSCM (Lévy 2002) and mean-value Tutte (Floater 2003) fallbacks',
        optimization: 'SLIM symmetric Dirichlet (Rabinovich et al. 2017) with sparse PCG global step, flip-free line search, Anderson acceleration (Peng et al. 2018)',
        packing: 'Bitmap atlas packing with rotations, profile placement and scale search (xatlas / Blender uv_pack style)',
        metrics: 'Sander 2001 stretch, symmetric Dirichlet, exact UV boundary intersection tests, calibrated 0-100 score (log-normal curves per preset), texture efficiency'
      }
    };
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  }

  function exportCSV(rows, columns) {
    columns = columns || Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(6)) : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.map(cell).join(',')].concat(rows.map(r => columns.map(c => cell(r[c])).join(',')));
    return new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
  }

  /* ---------------- project files ---------------- */
  function bytesToBase64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const TYPED = { Float32Array, Float64Array, Int32Array, Uint32Array, Uint16Array, Int16Array, Uint8Array, Int8Array };
  function encodeTyped(arr) {
    return { $typed: arr.constructor.name, b64: bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)) };
  }
  function decodeTyped(obj) {
    const Ctor = TYPED[obj.$typed];
    if (!Ctor) throw new Error('Unknown typed array in project: ' + obj.$typed);
    const bytes = base64ToBytes(obj.b64);
    if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT) throw new Error('Corrupt ' + obj.$typed + ' in project file.');
    return new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
  }
  function encodeDeep(v) {
    if (ArrayBuffer.isView(v)) return encodeTyped(v);
    if (Array.isArray(v)) return v.map(encodeDeep);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) if (v[k] !== undefined && typeof v[k] !== 'function') o[k] = encodeDeep(v[k]); return o; }
    return v;
  }
  function decodeDeep(v) {
    if (Array.isArray(v)) return v.map(decodeDeep);
    if (v && typeof v === 'object') {
      if (typeof v.$typed === 'string' && typeof v.b64 === 'string') return decodeTyped(v);
      const o = {}; for (const k of Object.keys(v)) o[k] = decodeDeep(v[k]); return o;
    }
    return v;
  }
  function saveProject(state) {
    const payload = encodeDeep(Object.assign({ format: 'uvtoolkit-project', version: 1, createdAt: new Date().toISOString(), tool: TOOL }, state));
    return new Blob([JSON.stringify(payload)], { type: 'application/json' });
  }
  async function loadProject(input) {
    let text;
    if (typeof input === 'string') text = input;
    else if (input && input.text) text = await input.text();
    else throw new Error('loadProject expects a File, Blob or string.');
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Not a valid project file (JSON parse failed).'); }
    if (!data || data.format !== 'uvtoolkit-project') throw new Error('Not a UV Toolkit project file.');
    if (!(data.version >= 1 && data.version <= 1)) throw new Error('Unsupported project version ' + data.version + '.');
    const state = decodeDeep(data);
    if (!(state.positions instanceof Float32Array) || state.positions.length % 9) throw new Error('Project file has no valid mesh positions.');
    return state;
  }

  /* ---------------- ZIP (store) ---------------- */
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  async function makeZip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      let data = e.data;
      if (typeof data === 'string') data = enc.encode(data);
      else if (data && typeof data.arrayBuffer === 'function' && !(data instanceof Uint8Array)) data = new Uint8Array(await data.arrayBuffer());
      else if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      const name = enc.encode(e.name), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  UVApp.exporters = {
    downloadBlob, exportOBJ, exportOBJText, exportMTL, exportGLB, drawUVLayout, exportUVPNG, canvasToBlob,
    exportReport, exportCSV, saveProject, loadProject, makeZip, crc32, encodeTyped, decodeTyped, stripTyped, safeName
  };
})(typeof window !== 'undefined' ? window : globalThis);
