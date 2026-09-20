'use strict';
// Optional browser QA: PLAYWRIGHT_MODULE can point to an existing Playwright
// installation. Runtime/application code still has no package dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'browser-qa');
const checks = [];
function check(label, condition) { assert.ok(condition, label); checks.push(label); console.log('PASS ' + label); }

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const port = Number(process.env.UVTK_QA_PORT || 8015);
  const server = spawn(process.execPath, [path.join(root, 'tools/serve.js'), String(port)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error('Server exited ' + code))); });
    browser = await chromium.launch({ headless: true, ...(process.env.UVTK_BROWSER_CHANNEL ? { channel: process.env.UVTK_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const idle = () => page.waitForFunction(() => window.UVApp && UVApp.app.model && !UVApp.app.busy, null, { timeout: 60000 });
    await page.goto('http://127.0.0.1:' + port + '/');
    await page.waitForFunction(() => window.UVApp && UVApp.app.result && !UVApp.app.busy, null, { timeout: 60000 });
    check('default atlas renders in a worker with valid UVs', await page.evaluate(() => UVApp.app.client.mode === 'worker' && UVApp.app.result.metrics.score.valid));
    check('mesh health preflight is visible', await page.locator('#mesh-health-status').innerText() === 'clear');

    // Two materials, two disconnected UV islands and a texture transform.
    const obj = 'mtllib sample.mtl\no two-parts\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 2 0 0\nv 3 0 0\nv 3 1 0\nv 2 1 0\nvt .05 .05\nvt .45 .05\nvt .45 .45\nvt .05 .45\nvt .55 .55\nvt .95 .55\nvt .95 .95\nvt .55 .95\nusemtl red\nf 1/1 2/2 3/3\nf 1/1 3/3 4/4\nusemtl green\nf 5/5 6/6 7/7\nf 5/5 7/7 8/8\n';
    const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0,0,8,8); x.fillStyle = '#2266ff'; x.fillRect(0,0,4,4); return c.toDataURL().split(',')[1]; });
    await page.locator('#file-input').setInputFiles([
      { name: 'sample.obj', mimeType: 'text/plain', buffer: Buffer.from(obj) },
      { name: 'sample.mtl', mimeType: 'text/plain', buffer: Buffer.from('newmtl red\nKd 1 .1 .1\nmap_Kd -s 2 3 1 -o .2 .1 0 checker.png\nnewmtl green\nKd .1 1 .1\nmap_Kd checker.png\n') },
      { name: 'checker.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }
    ]);
    await idle();
    check('multi-file OBJ import keeps both materials', await page.evaluate(() => UVApp.app.model.materials.filter(m => m.map).length === 2));
    await page.selectOption('#view-texture', 'original');
    check('original preview applies separate material groups', await page.evaluate(() => Array.isArray(UVApp.app.viewport.mesh.material) && UVApp.app.viewport.mesh.geometry.groups.length === 2));
    await page.locator('summary').filter({ hasText: 'Texture & bake' }).click();
    const source = await page.evaluate(() => Array.from(UVApp.app.model.originalUV));
    await page.click('#btn-adopt-source'); await idle();
    check('adopt imported layout preserves every UV', JSON.stringify(source) === JSON.stringify(await page.evaluate(() => Array.from(UVApp.app.result.uv))));
    check('imported margins are explicitly unknown', await page.evaluate(() => !UVApp.app.result.metrics.bake.paddingKnown));
    await page.click('#btn-analyze-source'); await idle();
    check('imported analysis displays the real island labels', await page.evaluate(() => new Set(UVApp.app.uvView.data.faceChart).size === 2));
    await page.click('#btn-current-result');
    await page.selectOption('#view-texture', 'charts');

    // Click the first imported island in canvas coordinates.
    const pt = await page.evaluate(() => { const v = UVApp.app.uvView, r = v.canvas.getBoundingClientRect(); return { x: r.left + v.view.ox + .25 * v.view.s, y: r.top + v.view.oy - .25 * v.view.s }; });
    await page.mouse.click(pt.x, pt.y);
    check('island selection exposes chart editing', await page.locator('#btn-transform-chart').isEnabled());
    await page.fill('#chart-rotation', '90'); await page.fill('#chart-scale', '0.8');
    await page.click('#btn-transform-chart'); await idle();
    const edited = await page.evaluate(() => Array.from(UVApp.app.result.uv));
    check('chart edit changes UV coordinates', JSON.stringify(source) !== JSON.stringify(edited));
    await page.click('#btn-undo'); await idle();
    check('undo restores exact imported coordinates', JSON.stringify(source) === JSON.stringify(await page.evaluate(() => Array.from(UVApp.app.result.uv))));
    await page.click('#btn-redo'); await idle();
    check('redo restores exact edited coordinates', JSON.stringify(edited) === JSON.stringify(await page.evaluate(() => Array.from(UVApp.app.result.uv))));

    await page.selectOption('#resolution', '512');
    await page.click('#btn-repack'); await idle();
    check('repack establishes effective padding and valid UVs', await page.evaluate(() => UVApp.app.result.metrics.score.valid && UVApp.app.result.metrics.bake.paddingKnown && UVApp.app.result.opts.packing.resolution === 512));
    await page.click('#btn-undo'); await idle();
    check('undo restores the settings controls with the result', await page.inputValue('#resolution') === '2048');
    await page.click('#btn-redo'); await idle();

    const materialBefore = await page.evaluate(async () => UVApp.exporters.captureMaterials(UVApp.app.model.materials));
    const before = await page.evaluate(() => Array.from(UVApp.app.result.uv));
    await page.click('#btn-export');
    const downloaded = page.waitForEvent('download');
    await page.click('[data-export="project"]');
    const download = await downloaded, projectPath = path.join(output, 'roundtrip.uvtk.json');
    await download.saveAs(projectPath);
    await page.locator('#project-input').setInputFiles(projectPath); await idle();
    check('project reopen restores exact atlas coordinates', JSON.stringify(before) === JSON.stringify(await page.evaluate(() => Array.from(UVApp.app.result.uv))));
    const materialAfter = await page.evaluate(async () => UVApp.exporters.captureMaterials(UVApp.app.model.materials));
    check('project reopen preserves texture pixels, colours and transforms', JSON.stringify(materialBefore) === JSON.stringify(materialAfter));
    await page.selectOption('#view-texture', 'original');
    check('reopened original preview retains both materials', await page.evaluate(() => UVApp.app.viewport.mesh.geometry.groups.length === 2));
    await page.selectOption('#bake-size', '1024');
    await page.click('#btn-bake');
    check('reopened textures can be rebaked', await page.evaluate(() => !!UVApp.app.baked && !UVApp.app.bakeStale));
    await page.click('#btn-analyze-source'); await idle();
    await page.click('#btn-current-result');
    check('returning from imported analysis keeps the existing bake current', await page.evaluate(() => !!UVApp.app.baked && !UVApp.app.bakeStale));

    // Cancel while the initial undo snapshot is in flight, before unwrapping.
    await page.evaluate(() => { document.getElementById('btn-unwrap').click(); document.getElementById('btn-cancel').click(); });
    await idle();
    check('immediate cancellation preserves the previous atlas', JSON.stringify(before) === JSON.stringify(await page.evaluate(() => Array.from(UVApp.app.result.uv))));
    check('cancelling an unchanged layout preserves bake freshness', await page.evaluate(() => !!UVApp.app.baked && !UVApp.app.bakeStale));
    check('cancel restores a usable engine result', await page.evaluate(async () => !!(await UVApp.app.client.snapshot()).uv));

    // Delay file decoding deterministically to exercise Cancel before worker setup.
    await page.evaluate(() => {
      window.qaPreviousModel = UVApp.app.model;
      window.qaPreviousClient = UVApp.app.client;
      const original = UVApp.exporters.loadProject;
      UVApp.exporters.loadProject = async (...args) => { UVApp.exporters.loadProject = original; const p = await original(...args); await new Promise(resolve => setTimeout(resolve, 500)); return p; };
    });
    await page.locator('#project-input').setInputFiles(projectPath);
    await page.click('#btn-cancel'); await idle();
    check('cancel during project reading retains the current model and engine', await page.evaluate(() => UVApp.app.model === window.qaPreviousModel && UVApp.app.client === window.qaPreviousClient));

    const validProject = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    validProject.snapshot.meshKey = 'different-mesh';
    await page.locator('#project-input').setInputFiles({ name: 'wrong-mesh.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(validProject)) }); await idle();
    check('failed snapshot load retains current model and atlas', JSON.stringify(before) === JSON.stringify(await page.evaluate(() => Array.from(UVApp.app.result.uv))));
    check('failed load gives actionable feedback', (await page.locator('#status-text').innerText()).includes('previous work kept'));
    await page.locator('#project-input').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{oops') }); await idle();
    check('malformed project leaves the prior result intact', JSON.stringify(before) === JSON.stringify(await page.evaluate(() => Array.from(UVApp.app.result.uv))));

    await page.selectOption('#view-texture', 'charts');
    await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 15000 });
    await page.locator('.sidebar').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
    await page.click('#btn-fit3d'); await page.click('#btn-fituv');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.click('#btn-theme');
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.click('#btn-fit3d');
    await page.waitForFunction(() => UVApp.app.viewport.camera.aspect < 1);
    await page.screenshot({ path: path.join(output, 'compact-light.png'), fullPage: true });
    check('compact viewport has no horizontal page overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check('browser has no uncaught errors', errors.length === 0);

    const disk = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await disk.goto(pathToFileURL(path.join(root, 'index.html')).href);
    await disk.waitForFunction(() => window.UVApp && UVApp.app.result && !UVApp.app.busy, null, { timeout: 60000 });
    check('direct file opening still produces valid UVs', await disk.evaluate(() => UVApp.app.result.metrics.score.valid));
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ date: new Date().toISOString(), browser: await browser.version(), checks, errors }, null, 2));
    console.log(checks.length + ' browser checks passed. Screenshots: ' + output);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
