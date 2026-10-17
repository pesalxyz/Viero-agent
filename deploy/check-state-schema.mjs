#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) throw new Error('usage: check-state-schema.mjs STATE_DIR...');
for (const dir of dirs) {
  for (const name of ['strategy-state.json', 'controls.json']) {
    const file = path.join(dir, name);
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw new Error(`invalid JSON: ${file}`); }
    if (name === 'strategy-state.json' && value.version !== 1) throw new Error(`unsupported strategy state schema: ${file}`);
    if (name === 'controls.json' && (typeof value !== 'object' || value === null)) throw new Error(`invalid controls schema: ${file}`);
  }
}
console.log('state schema compatible');
