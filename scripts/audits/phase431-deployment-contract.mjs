#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'viero-deploy-contract-'));
try {
  const install = await readFile('deploy/install-release.sh', 'utf8');
  const rollback = await readFile('deploy/rollback-release.sh', 'utf8');
  assert.match(install, /if \$start_service; then[\s\S]*systemctl enable viero-agent\.service/, 'activation must be explicit');
  const noStart = install.split('if $start_service; then')[0];
  assert.doesNotMatch(noStart, /systemctl enable viero-(agent|telegram|signer)\.service/, 'no-start path enables services');
  assert.match(install, /Missing required configuration/, 'missing configuration must fail clearly');
  assert.match(install, /sensitive\/runtime file detected/, 'release copy must reject sensitive files');
  assert.doesNotMatch(rollback, /systemctl restart|systemctl start/, 'rollback must never auto-start');
  assert.match(rollback, /systemctl stop viero-agent\.service viero-telegram\.service viero-signer\.service/, 'rollback preserves stopped state');
  const state = path.join(root, 'state'); await mkdir(state); await exec('node', ['deploy/check-state-schema.mjs', state]);
  await writeFile(path.join(state, 'strategy-state.json'), JSON.stringify({ version: 999 }));
  await assert.rejects(exec('node', ['deploy/check-state-schema.mjs', state]));
  const log = path.join(root, 'systemctl.log'); const mock = path.join(root, 'systemctl');
  await writeFile(mock, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o700 });
  await exec(mock, ['stop', 'viero-agent.service', 'viero-signer.service']);
  await exec(mock, ['disable', 'viero-agent.service', 'viero-signer.service']);
  const calls = await readFile(log, 'utf8'); assert.doesNotMatch(calls, /start|restart/);
  console.log(JSON.stringify({ isolated: true, checks: 8, mockSystemctlCalls: calls.trim().split('\n').length }));
} finally { await rm(root, { recursive: true, force: true }); }
