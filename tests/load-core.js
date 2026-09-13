'use strict';
/* Loads the pure-JS UV kernel for node --test. The core modules are classic
 * scripts that register themselves on a global `UVCore`, so we evaluate them
 * in dependency order inside a fresh VM context and build the namespace. */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const CORE_DIR = path.join(__dirname, '..', 'src', 'core');
// Order matters: later modules may use exports of earlier ones via `C`.
const ORDER = require('./core-order.json');

function makeContext() {
  const sandbox = {
    console, Math, Date, JSON, Error, Number, String, Array, Object, Map, Set,
    Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array, Int8Array, Uint16Array, Int16Array, ArrayBuffer,
    Infinity, NaN, isFinite, isNaN, performance: globalThis.performance,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return vm.createContext(sandbox);
}

function loadCore({ viaSource = false } = {}) {
  const context = makeContext();
  for (const file of ['registry.js', ...ORDER]) {
    const src = fs.readFileSync(path.join(CORE_DIR, file), 'utf8');
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

module.exports = { loadCore };
