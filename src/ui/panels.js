/* Results panels: score gauge, improvements, metrics, bake readiness, chart inspector,
 * history charts and the A/B compare table. */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v)) ? '–' : !isFinite(v) ? '∞' : Math.abs(v) >= 1e4 ? v.toExponential(2) : (+v).toFixed(d);
  const pct = (v, d = 1) => (v === null || v === undefined || !isFinite(v)) ? '–' : (100 * v).toFixed(d) + '%';

  const PRESET_LABEL = { game_hero: 'game hero asset', game_prop: 'game prop', lightmap: 'lightmap', film_udim: 'film / VFX', vfx: 'film / VFX' };
  const GRADE = (s) => s >= 90 ? ['Excellent', 'var(--good)'] : s >= 75 ? ['Good', 'var(--accent-2)'] : s >= 50 ? ['Fair', 'var(--ok)'] : ['Needs work', 'var(--bad)'];

  let historyChart = null, histChart = null;
  const history = [];

  function renderScore(m) {
    const fg = $('gauge-fg');
    if (!m) { $('score-num').textContent = '–'; $('score-grade').textContent = 'not unwrapped'; fg.style.strokeDashoffset = 314.16; $('score-gate').hidden = true; return; }
    const s = m.score.score, [label, color] = GRADE(s);
    $('score-num').textContent = s;
    $('score-grade').textContent = label;
    fg.style.stroke = color;
    fg.style.strokeDashoffset = (314.16 * (1 - s / 100)).toFixed(1);
    $('score-preset').textContent = 'Target: ' + (PRESET_LABEL[m.score.preset] || m.score.preset);
    const gate = $('score-gate');
    gate.hidden = !m.score.gate;
    if (m.score.gate) gate.textContent = 'Capped at ' + Math.round(m.score.gate.cap * 100) + ': ' + m.score.gate.reason;
  }

  function renderImprovements(m, onAction) {
    const ul = $('improve-list');
    ul.innerHTML = '';
    if (!m) { ul.innerHTML = '<li class="hint">Run an unwrap to get suggestions.</li>'; return; }
    const items = m.score.explanations || [];
    if (!items.length) { ul.innerHTML = '<li class="hint">Nothing significant left to gain for this target. 🎉</li>'; return; }
    for (const e of items) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="gain">' + (e.gain > 0 ? '+' + e.gain.toFixed(0) : '!') + '</span><span class="msg">' + esc(e.message) + '<small>' + esc(e.action) + '</small></span>';
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = 'Fix';
      btn.title = e.action;
      btn.addEventListener('click', () => onAction(e.metric));
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function card(k, v, grade, title) {
    return '<div class="metric ' + (grade || '') + '" title="' + esc(title || '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }

  function renderMetrics(r) {
    const grid = $('metric-grid');
    if (!r) { grid.innerHTML = ''; $('eff-bar').hidden = true; return; }
    const m = r.metrics, g = m.score.grades || {};
    const td = m.texelDensity;
    grid.innerHTML = [
      card('Charts', m.chartCount, g.frag, 'Number of UV islands. Fewer charts = fewer seams, but usually more stretch.'),
      card('Stretch (SD)', num(m.sdMean, 4), g.sd, 'Symmetric Dirichlet energy at global scale. 1.0000 = perfectly isometric.'),
      card('Stretch L2', num(m.stretchL2, 4), g.sd, 'Sander et al. 2001 geometric stretch. 1.0 is ideal.'),
      card('Angle error', num(m.angleMeanDeg, 2) + '°', g.angle, 'Area-weighted mean corner angle distortion.'),
      card('Flipped', m.flipped, m.flipped ? 'bad' : 'good', 'Triangles mirrored in UV space. Must be 0.'),
      card('Overlaps', m.bijectivity.valid ? 0 : (m.bijectivity.overlappingPairs.length + m.bijectivity.selfIntersectingCharts.length), m.bijectivity.valid ? 'good' : 'bad', 'Exact chart boundary intersection test.'),
      card('Texel density', Math.round(td.pxPerUnit) + '<small> px/u</small>', g.td, 'Mean texels per model unit at ' + td.resolution + 'px. CV ' + pct(td.cv)),
      card('Density CV', pct(td.cv), g.td, 'Variation of texel density across charts. 0% = perfectly even.'),
      card('Texture use', pct(m.efficiency.textureEff), g.waste, 'Packing efficiency × stretch efficiency: how much of the texture carries useful, undistorted detail.'),
      card('Equiv. res.', Math.round(m.efficiency.equivalentResolution) + 'px', g.waste, 'The resolution a perfect, fully used atlas would need to match this one.'),
      card('Seams', num(m.seamLength3D, 2), g.seams, 'Total 3D seam length. Normalised: ' + num(m.seamNorm, 2)),
      card('Unwrap time', Math.round(r.timings.total) + ' ms', '', Object.entries(r.timings).map(([k, v]) => k + ' ' + Math.round(v) + 'ms').join(', '))
    ].join('');
    const eff = m.efficiency;
    $('eff-bar').hidden = false;
    $('eff-used').style.width = pct(eff.textureEff, 2);
    $('eff-stretch').style.width = pct(Math.max(0, eff.packingEff - eff.textureEff), 2);
    $('eff-text').textContent = 'Charts cover ' + pct(eff.packingEff) + ' of the texture; ' + pct(1 - eff.stretchEff) + ' of that is lost to stretch.';
  }

  function renderBake(r) {
    const ul = $('bake-checks');
    if (!r) { ul.innerHTML = '<li class="hint">–</li>'; return; }
    const m = r.metrics, b = m.bake, preset = (UVApp.PRESETS || {})[m.score.preset] || {};
    const target = preset.targetMip !== undefined ? preset.targetMip : 2;
    const items = [
      [m.flipped === 0 ? 'pass' : 'fail', 'No flipped triangles', m.flipped],
      [m.bijectivity.valid ? 'pass' : 'fail', 'No overlapping charts', m.bijectivity.valid ? '0' : 'overlap'],
      [m.outOfRange === 0 ? 'pass' : 'fail', 'All UVs inside 0–1', m.outOfRange],
      [r.projection ? 'warn' : (b.maxSafeMip >= target ? 'pass' : 'warn'), 'Padding safe to mip ' + target, r.projection ? 'n/a' : 'mip ' + b.maxSafeMip],
      [m.texelDensity.cv <= 0.1 ? 'pass' : m.texelDensity.cv <= 0.25 ? 'warn' : 'fail', 'Even texel density', pct(m.texelDensity.cv)],
      [b.subTexelCharts === 0 ? 'pass' : 'warn', 'No sub-texel charts', b.subTexelCharts],
      [m.degenerate === 0 ? 'pass' : 'warn', 'No collapsed triangles', m.degenerate]
    ];
    ul.innerHTML = items.map(([cls, label, val]) => '<li class="' + cls + '"><span>' + esc(label) + '</span><em>' + esc(val) + '</em></li>').join('');
  }

  function renderChart(info) {
    const cardEl = $('chart-card');
    if (!info) { cardEl.hidden = true; return; }
    cardEl.hidden = false;
    $('chart-id').textContent = '#' + info.id;
    const rows = [
      ['Faces', info.faces], ['3D area', num(info.area3D, 4)], ['UV area', pct(info.areaUV, 2)], ['Stretch (SD)', num(info.sd, 4)],
      ['L2', num(info.l2, 4)], ['Flips', info.flips], ['Texel density', Math.round(info.pxPerUnit) + ' px/u (' + num(info.density, 2) + '×)'],
      ['Seam share', pct(info.seamShare)], ['Flattening', info.initMethod || '–'], ['Fallbacks', (info.fallbacks && info.fallbacks.length) ? info.fallbacks.join(', ') : 'none']
    ];
    $('chart-kv').innerHTML = rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('');
  }

  function themeColors() {
    const css = getComputedStyle(document.documentElement);
    return { text: css.getPropertyValue('--muted').trim(), grid: css.getPropertyValue('--line').trim(), a: css.getPropertyValue('--accent').trim(), b: css.getPropertyValue('--accent-2').trim(), c: css.getPropertyValue('--ok').trim() };
  }

  function initCharts() {
    if (!root.Chart) return;
    const t = themeColors();
    const scales = (y) => ({ x: { ticks: { color: t.text, maxTicksLimit: 6 }, grid: { color: t.grid } }, y: Object.assign({ ticks: { color: t.text }, grid: { color: t.grid } }, y) });
    historyChart = new root.Chart($('history-chart').getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Score', data: [], borderColor: t.b, backgroundColor: t.b, yAxisID: 'y', tension: 0.3, pointRadius: 2 },
        { label: 'Texture use %', data: [], borderColor: t.a, backgroundColor: t.a, yAxisID: 'y', tension: 0.3, pointRadius: 2 }
      ] },
      options: { animation: false, maintainAspectRatio: false, plugins: { legend: { labels: { color: t.text, boxWidth: 10 } } }, scales: scales({ min: 0, max: 100 }) }
    });
    histChart = new root.Chart($('hist-chart').getContext('2d'), {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Area share by stretch (SD)', data: [], backgroundColor: t.c }] },
      options: { animation: false, maintainAspectRatio: false, plugins: { legend: { labels: { color: t.text, boxWidth: 10 } } }, scales: scales({ beginAtZero: true }) }
    });
  }

  function pushHistory(m) {
    if (!m) return;
    history.push({ score: m.score.score, use: 100 * m.efficiency.textureEff });
    if (history.length > 40) history.shift();
    if (!historyChart) return;
    historyChart.data.labels = history.map((_, i) => i + 1);
    historyChart.data.datasets[0].data = history.map(h => h.score);
    historyChart.data.datasets[1].data = history.map(h => +h.use.toFixed(1));
    historyChart.update();
    const hb = m.histogram, bins = [], labels = [];
    const groups = 8, per = Math.ceil(hb.bins.length / groups);
    for (let gI = 0; gI < groups; gI++) {
      let s = 0;
      for (let i = gI * per; i < Math.min(hb.bins.length, (gI + 1) * per); i++) s += hb.bins[i];
      bins.push(+(100 * s).toFixed(2));
      labels.push('≤' + Number(hb.edges[Math.min(hb.edges.length - 1, (gI + 1) * per)]).toFixed(2));
    }
    histChart.data.labels = labels;
    histChart.data.datasets[0].data = bins;
    histChart.update();
  }

  function refreshTheme() {
    if (!historyChart) return;
    historyChart.destroy(); histChart.destroy();
    initCharts();
    const last = history.splice(0);
    for (const h of last) history.push(h);
    if (history.length) {
      historyChart.data.labels = history.map((_, i) => i + 1);
      historyChart.data.datasets[0].data = history.map(h => h.score);
      historyChart.data.datasets[1].data = history.map(h => +h.use.toFixed(1));
      historyChart.update();
    }
  }

  const COMPARE_COLS = [
    ['Score', e => e.score, 1, 0], ['Charts', e => e.charts, 0, 0], ['SD', e => e.sd, -1, 4], ['Angle°', e => e.angle, -1, 2],
    ['Use %', e => e.use, 1, 1], ['Seams', e => e.seams, -1, 1], ['ms', e => e.ms, -1, 0]
  ];
  function renderCompare(entries, onRestore, onRemove) {
    const table = $('compare-table');
    if (!entries.length) { table.innerHTML = '<tbody><tr><td class="hint">Pin results to compare settings side by side.</td></tr></tbody>'; return; }
    const base = entries[0];
    let html = '<thead><tr><th>Result</th>' + COMPARE_COLS.map(c => '<th>' + c[0] + '</th>').join('') + '<th></th></tr></thead><tbody>';
    entries.forEach((e, i) => {
      html += '<tr><td title="' + esc(e.description) + '">' + esc(e.label) + '</td>';
      for (const [, get, dir, d] of COMPARE_COLS) {
        const v = get(e), bv = get(base);
        const cls = i && dir && v !== bv ? ((v - bv) * dir > 0 ? 'better' : 'worse') : '';
        html += '<td class="' + cls + '">' + (typeof v === 'number' ? v.toFixed(d) : v) + '</td>';
      }
      html += '<td><button class="small ghost" data-restore="' + i + '" title="Restore this result">↺</button><button class="small ghost" data-remove="' + i + '" title="Remove">✕</button></td></tr>';
    });
    table.innerHTML = html + '</tbody>';
    table.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => onRestore(+b.dataset.restore)));
    table.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => onRemove(+b.dataset.remove)));
  }

  function log(lines) {
    const ul = $('log');
    const time = new Date().toLocaleTimeString();
    for (const line of [].concat(lines)) {
      const li = document.createElement('li');
      li.textContent = time + '  ' + line;
      ul.prepend(li);
    }
    while (ul.children.length > 80) ul.lastChild.remove();
  }

  UVApp.panels = { renderScore, renderImprovements, renderMetrics, renderBake, renderChart, initCharts, pushHistory, refreshTheme, renderCompare, log, fmt: { num, pct } };
})(typeof window !== 'undefined' ? window : globalThis);
