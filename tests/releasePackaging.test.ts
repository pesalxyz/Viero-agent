import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('immutable release packaging includes the RPC telemetry report script', async () => {
  const root = process.cwd();
  const packaging = await readFile(join(root, 'deploy/package-release.sh'), 'utf8');
  const report = await readFile(join(root, 'scripts/viero-rpc-report.mjs'), 'utf8');

  assert.match(packaging, /mkdir -p \"\$release\/scripts\"/);
  assert.match(packaging, /cp scripts\/viero-rpc-report\.mjs \"\$release\/scripts\/\"/);
  assert.match(report, /RPC telemetry unavailable/);
});
