import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { FileRepository } from '../src/viero/storage/repositories.js';
import { emptyStrategyState } from '../src/viero/execution/liveState.js';

test('strategy projection replacement remains valid across orphan temp and concurrent repairs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-projection-crash-'));
  try {
    const repository = new FileRepository(root); await repository.initialize();
    await repository.setStrategyState(emptyStrategyState());
    const target = join(root, 'strategy-state.json');
    await writeFile(`${target}.crash.tmp`, '{"truncated":'); // simulated crash before rename
    assert.deepEqual(await repository.strategyState(), emptyStrategyState());
    await Promise.all(Array.from({ length: 8 }, () => repository.setStrategyState(emptyStrategyState())));
    const persisted = await repository.strategyState(); assert.deepEqual(persisted, emptyStrategyState());
    const files = await readdir(root); assert.ok(files.every(file => !file.endsWith('.tmp')) || files.some(file => file.endsWith('.crash.tmp')));
    const text = await readFile(target, 'utf8'); assert.doesNotThrow(() => JSON.parse(text));
    await repository.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
