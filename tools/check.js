'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : /\.(js|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);
}
for (const file of ['src', 'tests', 'tools'].flatMap(d => files(path.join(root, d)))) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log('JavaScript syntax checks passed. Running regression suite…');
const result = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', cwd: root });
process.exit(result.status || (result.error ? 1 : 0));
