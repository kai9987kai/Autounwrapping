'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowser } = require('./load-browser');

test('frame fits the complete bounding sphere in narrow and wide 3D panes', () => {
  const ctx = loadBrowser({ three: true, scripts: ['src/ui/viewport.js'] });
  const T = ctx.THREE;
  for (const aspect of [0.3, 0.6, 1, 2]) {
    const camera = new T.PerspectiveCamera(45, aspect, .01, 100);
    const center = new T.Vector3(2, 3, -1), radius = 3;
    const view = { camera, mesh: { geometry: { boundingSphere: new T.Sphere(center, radius) } }, controls: { target: new T.Vector3(), update() {} }, requestRender() {} };
    ctx.UVApp.Viewport.prototype.frame.call(view);
    camera.lookAt(center); camera.updateMatrixWorld();
    for (let i = 0; i < 360; i++) {
      const a = i * Math.PI / 180;
      for (const point of [new T.Vector3(radius * Math.cos(a), radius * Math.sin(a), 0), new T.Vector3(radius * Math.cos(a), 0, radius * Math.sin(a))]) {
        point.add(center).project(camera);
        assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1, 'sphere remains inside pane at aspect ' + aspect);
      }
    }
  }
});

test('UV resize preserves relative zoom and the UV coordinate at pane centre', () => {
  const ctx = loadBrowser({ scripts: ['src/ui/uv-view.js'] });
  const view = { w: 800, h: 600, view: { s: 540, ox: 70, oy: 420 }, canvas: { parentElement: { getBoundingClientRect: () => ({ width: 320, height: 500 }) } } };
  const u = (view.w / 2 - view.view.ox) / view.view.s;
  const v = (view.view.oy - view.h / 2) / view.view.s;
  ctx.UVApp.UVView.prototype.resize.call(view);
  assert.ok(Math.abs(view.view.s - 288) < 1e-10);
  assert.ok(Math.abs((view.w / 2 - view.view.ox) / view.view.s - u) < 1e-10);
  assert.ok(Math.abs((view.view.oy - view.h / 2) / view.view.s - v) < 1e-10);
});
