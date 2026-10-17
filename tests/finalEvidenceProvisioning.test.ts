import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEvidenceHandoff, writeEvidenceHandoff } from '../src/viero/storage/evidenceHandoff.js';

test('protected Ed25519 key files sign and verify; rotation does not silently trust old evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viero-evidence-keys-'));
  const beforePrivate = process.env.VIERO_EVIDENCE_SIGNING_PRIVATE_KEY_FILE;
  const beforePublic = process.env.VIERO_EVIDENCE_SIGNING_PUBLIC_KEY_FILE;
  try {
    const keys = generateKeyPairSync('ed25519'), rotated = generateKeyPairSync('ed25519');
    const privateFile = join(root, 'private.pem'), publicFile = join(root, 'public.pem'), evidence = join(root, 'evidence.json');
    await writeFile(privateFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(publicFile, keys.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o600 });
    process.env.VIERO_EVIDENCE_SIGNING_PRIVATE_KEY_FILE = privateFile;
    process.env.VIERO_EVIDENCE_SIGNING_PUBLIC_KEY_FILE = publicFile;
    await writeEvidenceHandoff(evidence, []);
    assert.deepEqual(await readEvidenceHandoff(evidence), []);
    await writeFile(publicFile, rotated.publicKey.export({ format: 'pem', type: 'spki' })); await chmod(publicFile, 0o600);
    await assert.rejects(() => readEvidenceHandoff(evidence), /EVIDENCE_HANDOFF_INVALID/);
    await writeFile(publicFile, keys.publicKey.export({ format: 'pem', type: 'spki' })); await chmod(publicFile, 0o600);
    assert.deepEqual(await readEvidenceHandoff(evidence), []);
  } finally {
    if (beforePrivate === undefined) delete process.env.VIERO_EVIDENCE_SIGNING_PRIVATE_KEY_FILE;
    else process.env.VIERO_EVIDENCE_SIGNING_PRIVATE_KEY_FILE = beforePrivate;
    if (beforePublic === undefined) delete process.env.VIERO_EVIDENCE_SIGNING_PUBLIC_KEY_FILE;
    else process.env.VIERO_EVIDENCE_SIGNING_PUBLIC_KEY_FILE = beforePublic;
    await rm(root, { recursive: true, force: true });
  }
});
