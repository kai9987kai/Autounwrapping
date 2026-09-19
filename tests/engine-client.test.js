'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { loadBrowser } = require('./load-browser');
const F = require('./fixtures');

/* The real kernel inside a browser-like context, plus a fake Worker that runs
 * the serialised worker source in its own VM realm (exactly what a Blob URL
 * worker would evaluate) and pipes messages through structuredClone. */
function setup(opts = {}) {
  const ctx = loadBrowser({ core: true, scripts: ['src/client/engine-client.js'] });
  const workers = [];
  const workerFactory = (source) => {
    const w = { onmessage: null, onerror: null, terminated: false, posted: [] };
    const scope = { postMessage: (m, transfer) => { if (w.terminated) return; const copy = structuredClone(m, { transfer }); setTimeout(() => { if (!w.terminated && w.onmessage) w.onmessage({ data: copy }); }, 0); } };
    const sandbox = { console, Math, Date, JSON, Error, TypeError, Number, String, Boolean, Array, Object, Map, Set, Symbol, Promise,
      Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array, Uint16Array, Int8Array, Int16Array, ArrayBuffer, DataView, Infinity, NaN, isFinite, isNaN, performance, setTimeout };
    sandbox.self = sandbox; sandbox.globalThis = sandbox;
    sandbox.postMessage = scope.postMessage;
    const context = vm.createContext(sandbox);
    w.postMessage = (m, transfer) => {
      if (w.terminated) return;
      w.posted.push(m.op);
      const copy = structuredClone(m, { transfer });
      setTimeout(() => { if (!w.terminated && sandbox.onmessage) sandbox.onmessage({ data: copy }); }, 0);
    };
    w.terminate = () => { w.terminated = true; };
    if (!opts.neverReady && !(opts.failRestart && workers.length)) setTimeout(() => vm.runInContext(source, context), 0);
    workers.push(w);
    return w;
  };
  return { ctx, workers, workerFactory };
}

test('worker mode: ready handshake, unwrap with progress, results arrive with typed arrays', async () => {
  const { ctx, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  assert.equal(client.mode, 'worker');
  assert.ok(client.methods.includes('unwrap'));
  const stages = new Set();
  client.onProgress(p => stages.add(p.stage));
  const info = await client.setMesh(F.uvSphere(12, 8));
  assert.equal(info.faceCount, F.uvSphere(12, 8).length / 9);
  const r = await client.unwrap({});
  assert.equal(r.uv.constructor.name, 'Float32Array');
  assert.equal(r.uv.length, 6 * info.faceCount);
  assert.ok(stages.has('pack') && stages.has('metrics'));
  await assert.rejects(client.call('doesNotExist'), /Unknown engine operation/);
  client.dispose();
});

test('calls run strictly in order even when issued concurrently', async () => {
  const { ctx, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  await client.setMesh(F.cube());
  const order = [];
  await Promise.all([
    client.unwrap({ mode: 'box' }).then(() => order.push('unwrap')),
    client.repack({}).then(() => order.push('repack')),
    client.metrics({}).then(() => order.push('metrics'))
  ]);
  assert.deepEqual(order, ['unwrap', 'repack', 'metrics']);
  client.dispose();
});

test('cancel() rejects with CancelError, respawns the worker and replays mesh + seams', async () => {
  const { ctx, workers, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  await client.setMesh(F.torusKnot(0.8, 0.3, 60, 10));
  await client.seamsFromAngle(10);
  const seams = (await client.getManualCut()).reduce((s, x) => s + x, 0);
  // the fake worker shares this thread, so cancel while both jobs are in flight (posted, not yet run)
  const pending = assert.rejects(client.unwrap({}), (e) => e.name === 'CancelError');
  const queued = assert.rejects(client.relax({}), (e) => e.name === 'CancelError');
  await client.cancel();
  await pending;
  await queued;
  assert.equal(workers.length, 2);
  assert.ok(workers[0].terminated);
  // engine state restored in the new worker
  const after = (await client.getManualCut()).reduce((s, x) => s + x, 0);
  assert.equal(after, seams);
  const r = await client.unwrap({ mode: 'box' });
  assert.ok(r.metrics.faces > 0);
  client.dispose();
});

test('falls back to the main thread when the worker never becomes ready', async () => {
  const { ctx, workers, workerFactory } = setup({ neverReady: true });
  const client = await new ctx.UVApp.EngineClient({ workerFactory, readyTimeoutMs: 50 }).init();
  assert.equal(client.mode, 'main');
  assert.ok(workers[0].terminated, 'the timed-out worker is terminated');
  assert.equal(workers[0].onmessage, null, 'late ready messages cannot resurrect it');
  const stages = new Set();
  client.onProgress(p => stages.add(p.stage));
  await client.setMesh(F.cube());
  const r = await client.unwrap({});
  assert.ok(r.metrics.bijectivity.valid);
  assert.ok(stages.has('metrics'));
  client.dispose();
});

test('rejected source UV updates do not replace accepted restart state', async () => {
  const { ctx, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  const mesh = F.cube();
  await client.setMesh(mesh);
  const original = new Float32Array(mesh.length / 9 * 6);
  for (let f = 0; f < original.length / 6; f++) original.set([0, 0, 1, 0, 0, 1], 6 * f);
  await client.setSourceUV(original);
  await assert.rejects(client.setSourceUV(new Float32Array(3)), /setSourceUV/);
  const pending = assert.rejects(client.unwrap({ mode: 'box' }), e => e.name === 'CancelError');
  await client.cancel(); await pending;
  const source = await client.analyzeSource({});
  assert.equal(source.faces, mesh.length / 9);
  client.dispose();
});

test('restored manual seams survive an immediate worker cancellation', async () => {
  const { ctx, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  await client.setMesh(F.cube());
  await client.seamsFromAngle(30);
  const snapshot = await client.snapshot();
  const expected = Array.from(snapshot.manualCut);
  assert.ok(expected.some(Boolean));
  await client.clearSeams();
  await client.restore(snapshot);
  const pending = assert.rejects(client.unwrap({ mode: 'box' }), e => e.name === 'CancelError');
  await client.cancel(); await pending;
  assert.deepEqual(Array.from(await client.getManualCut()), expected);
  client.dispose();
});

test('dispose settles active and queued calls and rejects future calls', async () => {
  const { ctx, workers, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  await client.setMesh(F.cube());
  const active = assert.rejects(client.unwrap({}), e => e.name === 'CancelError');
  const queued = assert.rejects(client.meshInfo(), e => e.name === 'CancelError');
  client.dispose();
  await active; await queued;
  assert.ok(workers[0].terminated);
  await assert.rejects(client.meshInfo(), e => e.name === 'CancelError');
  await assert.rejects(client.callTransfer('setMesh', [F.cube()], []), e => e.name === 'CancelError');
  assert.equal(client.active, null);
});

test('dispose during initialization terminates the starting worker without fallback', async () => {
  const { ctx, workers, workerFactory } = setup({ neverReady: true });
  const client = new ctx.UVApp.EngineClient({ workerFactory });
  const starting = assert.rejects(client.init(), e => e.name === 'CancelError');
  client.dispose();
  await starting;
  assert.ok(workers[0].terminated);
  assert.equal(client.engine, null);
});

test('worker restart can fall back to main mode with the accepted mesh and seams', async () => {
  const { ctx, workers, workerFactory } = setup({ failRestart: true });
  const client = await new ctx.UVApp.EngineClient({ workerFactory, readyTimeoutMs: 100 }).init();
  const options = { weldTolerance: 0.00001 };
  const before = await client.setMesh(F.cube(), options);
  await client.seamsFromAngle(30);
  const expected = Array.from(await client.getManualCut());
  options.weldTolerance = 10; // caller-owned settings cannot alter replay state
  const pending = assert.rejects(client.unwrap({}), e => e.name === 'CancelError');
  await client.cancel(); await pending;
  assert.equal(client.mode, 'main');
  assert.ok(workers.every(w => w.terminated));
  assert.equal((await client.meshInfo()).weldTolerance, before.weldTolerance);
  assert.deepEqual(Array.from(await client.getManualCut()), expected);
  client.dispose();
});

test('transferred mesh buffers remain available for cancellation recovery', async () => {
  const { ctx, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  const positions = F.cube(), count = positions.length / 9;
  await client.callTransfer('setMesh', [positions], [positions.buffer]);
  assert.equal(positions.byteLength, 0, 'caller buffer transferred');
  const pending = assert.rejects(client.unwrap({}), e => e.name === 'CancelError');
  await client.cancel(); await pending;
  assert.equal((await client.meshInfo()).faceCount, count);
  client.dispose();
});

test('main mode: errors propagate and cancel rejects queued work', async () => {
  const { ctx } = setup();
  const client = await new ctx.UVApp.EngineClient({ forceMain: true }).init();
  assert.equal(client.mode, 'main');
  await assert.rejects(client.relax({}), /No mesh|needs an atlas/);
  await client.setMesh(F.cube());
  const a = client.unwrap({});
  const b = client.unwrap({});
  await client.cancel();
  await assert.rejects(b, (e) => e.name === 'CancelError');
  await a.catch(() => {});
});

test('calls issued during a restart wait for the replay (seams restored) instead of failing', async () => {
  const { ctx, workerFactory } = setup();
  const client = await new ctx.UVApp.EngineClient({ workerFactory }).init();
  await client.setMesh(F.torusKnot(0.8, 0.3, 40, 8));
  await client.seamsFromAngle(10);
  const expected = (await client.getManualCut()).reduce((s, x) => s + x, 0);
  assert.ok(expected > 0);
  const inflight = assert.rejects(client.unwrap({}), (e) => e.name === 'CancelError');
  const cancelling = client.cancel();
  const during = client.getManualCut();          // issued before the new worker is ready
  await inflight; await cancelling;
  assert.equal((await during).reduce((s, x) => s + x, 0), expected);
  await client.ready;
  const r = await client.unwrap({ mode: 'box' });
  assert.ok(r.metrics.faces > 0);
  client.dispose();
});
