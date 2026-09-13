'use strict';
/* Loads the pure-JS UV kernel for node --test. The core modules are classic
 * scripts that register themselves on a global `UVCore`, so we evaluate them
 * in dependency order inside a fresh VM context and build the namespace.
 *
 *   loadCore()                                  every module present on disk
 *   loadCore({ modules: ['math', 'mesh'] })     only these (+ registry), in ORDER
 *   loadCore({ viaSource: true })               round-trip through UVCore.source()
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const CORE_DIR = path.join(__dirname, '..', 'src', 'core');
// Order matters: later modules may use exports of earlier ones via `C`.
const ORDER = require('./core-order.json');

function makeContext() {
  const sandbox = {
    console, Math, Date, JSON, Error, TypeError, RangeError, Number, String, Boolean, Array, Object, Map, Set, WeakMap, Symbol, Promise,
    Float32Array, Float64Array, Int32Array, Uint8Array, Uint8ClampedArray, Uint32Array, Int8Array, Uint16Array, Int16Array, ArrayBuffer, DataView,
    Infinity, NaN, isFinite, isNaN, parseInt, parseFloat, performance: globalThis.performance,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return vm.createContext(sandbox);
}

function normalise(name) { return name.endsWith('.js') ? name : name + '.js'; }

function loadCore({ viaSource = false, modules = null } = {}) {
  const wanted = modules ? new Set(modules.map(normalise)) : null;
  const files = ORDER.filter(f => !wanted || wanted.has(f));
  if (wanted) {
    for (const w of wanted) if (!ORDER.includes(w)) throw new Error('loadCore: unknown module ' + w + ' (add it to tests/core-order.json)');
  }
  const context = makeContext();
  for (const file of ['registry.js', ...files]) {
    const full = path.join(CORE_DIR, file);
    if (!fs.existsSync(full)) {
      if (wanted && file !== 'registry.js') throw new Error('loadCore: requested module missing on disk: ' + file);
      continue; // module not written yet
    }
    const src = fs.readFileSync(full, 'utf8');
    vm.runInContext(src, context, { filename: file });
  }
  if (viaSource) {
    // Round-trip through the serialised source, exactly as the worker does.
    const text = vm.runInContext('UVCore.source()', context);
    const ctx2 = makeContext();
    vm.runInContext(text, ctx2, { filename: 'uvcore-worker-source.js' });
    return vm.runInContext('UVCore.build()', ctx2);
  }
  return vm.runInContext('UVCore.build()', context);
}

module.exports = { loadCore, ORDER };
