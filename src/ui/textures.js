/* Procedural preview textures (canvas-based, created lazily). */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};
  const cache = new Map();

  function canvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  function checkerCanvas(size = 1024, checks = 16) {
    const c = canvas(size), g = c.getContext('2d'), cell = size / checks;
    for (let y = 0; y < checks; y++) for (let x = 0; x < checks; x++) {
      g.fillStyle = (x + y) % 2 ? '#2b3445' : '#d9e2ee';
      g.fillRect(x * cell, y * cell, cell, cell);
    }
    g.strokeStyle = 'rgba(90,162,255,0.55)';
    g.lineWidth = Math.max(1, size / 512);
    for (let i = 0; i <= 4; i++) { const p = i * size / 4; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.moveTo(0, p); g.lineTo(size, p); g.stroke(); }
    return c;
  }

  /* Blender-style colour grid: hue columns, tint rows, labelled cells (orientation readable). */
  function colorGridCanvas(size = 2048) {
    const c = canvas(size), g = c.getContext('2d'), n = 8, cell = size / n;
    const letters = 'ABCDEFGH';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const hue = (x / n) * 360, light = 38 + (y / (n - 1)) * 30;
        g.fillStyle = 'hsl(' + hue + ',70%,' + light + '%)';
        g.fillRect(x * cell, y * cell, cell, cell);
        // quarter checks
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(x * cell, y * cell, cell / 2, cell / 2);
        g.fillRect(x * cell + cell / 2, y * cell + cell / 2, cell / 2, cell / 2);
        g.fillStyle = 'rgba(0,0,0,0.65)';
        g.font = 'bold ' + Math.round(cell * 0.28) + 'px sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(letters[x] + (n - y), x * cell + cell / 2, y * cell + cell / 2);
      }
    }
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = Math.max(1, size / 1024);
    for (let i = 0; i <= n * 4; i++) { const p = i * size / (n * 4); g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.moveTo(0, p); g.lineTo(size, p); g.stroke(); }
    return c;
  }

  function toTexture(key, make) {
    if (cache.has(key)) return cache.get(key);
    const THREE = root.THREE;
    const t = new THREE.CanvasTexture(make());
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if ('encoding' in t) t.encoding = THREE.sRGBEncoding;
    cache.set(key, t);
    return t;
  }

  UVApp.textures = {
    checkerCanvas, colorGridCanvas,
    checker: (size = 1024, checks = 16) => toTexture('checker' + size + '_' + checks, () => checkerCanvas(size, checks)),
    colorGrid: (size = 2048) => toTexture('grid' + size, () => colorGridCanvas(size))
  };
})(typeof window !== 'undefined' ? window : globalThis);
