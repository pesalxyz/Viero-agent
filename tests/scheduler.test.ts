import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('routine scheduler uses Agent.cycle as the sole screening cadence', async () => {
  const source = await readFile(new URL('../src/viero/cli.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('agent.tokenDiscovery.start()'), false);
  assert.match(source, /agent\.cycle\(\{ mode: 'live-readonly'/);
  assert.match(source, /const controls = await repo\.controls\(\)/);
  assert.match(source, /const routineChains = selected\.filter/);
});
