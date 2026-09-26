import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/viero/telegram.js';
import type { Repository } from '../src/viero/storage/repositories.js';

test('Telegram startup registers only the existing slash commands', async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const controller = new AbortController(); controller.abort();
  const repo = {
    async latest() { return null; }, async controls() { return { globalPaused: false, pausedChains: [], botState: 'STOPPED' as const }; },
  } as unknown as Repository;
  const bot = new TelegramBot({ token: '12345678901234567890', allowedUserIds: new Set([7]), agent: { signer: undefined } as never,
    repo, chains: [8453], tokenLimit: 1, poolLimit: 1, intervalSeconds: 300, signal: controller.signal,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method: String(_url).split('/').at(-1)!, body });
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    },
  });
  await bot.start();
  const registration = calls.find(call => call.method === 'setMyCommands');
  assert.ok(registration);
  assert.deepEqual(registration.body.commands, [
    { command: 'start', description: 'Start Viero' },
    { command: 'stop', description: 'Stop new LP entries' },
    { command: 'status', description: 'Show Viero status' },
    { command: 'settings', description: 'Configure LP strategy' },
    { command: 'report', description: 'Show latest screening report' },
    { command: 'help', description: 'Show available commands' },
    { command: 'block_tokens', description: 'Manage blocked discovery tokens' },
  ]);
});
