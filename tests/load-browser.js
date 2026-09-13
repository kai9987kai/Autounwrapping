'use strict';
/* Loads browser-side classic scripts (src/io, src/ui, src/client, vendor/three)
 * into a fresh VM context for node --test. There is no DOM: scripts must only
 * touch `document` / canvas lazily (inside functions), never at load time.
 *
 *   const ctx = loadBrowser({ three: ['loaders/OBJLoader.js'], scripts: ['src/io/loaders.js'] });
 *   ctx.UVApp.loaders ...   ctx.THREE ...
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* Minimal FileReader (node has Blob but no FileReader); enough for
 * THREE.GLTFExporter and project-file loading code paths. */
class MiniFileReader {
  constructor() { this.result = null; this.onload = null; this.onloadend = null; this.onerror = null; }
  _run(blob, kind) {
    const p = kind === 'text' ? blob.text() : blob.arrayBuffer();
    p.then(v => {
      if (kind === 'dataURL') v = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(v).toString('base64');
      this.result = v;
      const ev = { target: this };
      if (this.onload) this.onload(ev);
      if (this.onloadend) this.onloadend(ev);
    }, e => { if (this.onerror) this.onerror(e); });
  }
  readAsArrayBuffer(b) { this._run(b, 'buffer'); }
  readAsText(b) { this._run(b, 'text'); }
  readAsDataURL(b) { this._run(b, 'dataURL'); }
}

function makeContext(globals) {
  const sandbox = {
    console, Math, Date, JSON, Error, TypeError, RangeError, SyntaxError, Number, String, Boolean, Array, Object, Map, Set, WeakMap, WeakSet, Symbol, Promise, Proxy, Reflect, RegExp,
    Float32Array, Float64Array, Int32Array, Uint8Array, Uint8ClampedArray, Uint32Array, Int8Array, Uint16Array, Int16Array, BigInt64Array, BigUint64Array, ArrayBuffer, DataView,
    Infinity, NaN, isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, escape, unescape,
    TextEncoder, TextDecoder, URL, Blob: globalThis.Blob, atob: globalThis.atob, btoa: globalThis.btoa, fetch: globalThis.fetch,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
    performance: globalThis.performance,
    navigator: { userAgent: 'node', hardwareConcurrency: 4 },
    Request: globalThis.Request, Response: globalThis.Response, Headers: globalThis.Headers, AbortController: globalThis.AbortController,
    FileReader: MiniFileReader,
  };
  Object.assign(sandbox, globals || {});
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

function runFile(context, rel) {
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: path.relative(ROOT, full) });
}

/* three: false | true | string[] of vendor/three example files to add after three.min.js
 *   (e.g. ['OBJLoader.js', 'STLLoader.js']).  core: true also loads the UV kernel
 *   (registry + every module in tests/core-order.json present on disk) so
 *   `ctx.UVCore` exists. */
function loadBrowser({ three = false, core = false, scripts = [], globals = {} } = {}) {
  const context = makeContext(globals);
  if (three) {
    runFile(context, 'vendor/three/three.min.js');
    if (Array.isArray(three)) for (const f of three) runFile(context, path.join('vendor/three', f));
  }
  if (core) {
    runFile(context, 'src/core/registry.js');
    const order = Array.isArray(core) ? core.map(n => n.endsWith('.js') ? n : n + '.js') : require('./core-order.json');
    for (const f of order) {
      const rel = path.join('src/core', f);
      if (fs.existsSync(path.join(ROOT, rel))) runFile(context, rel);
    }
  }
  for (const s of scripts) runFile(context, s);
  return context;
}

module.exports = { loadBrowser, ROOT };
