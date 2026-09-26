#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { CHAIN_IDS, CHAINS } from './config/chains.js';
import { policySchema } from './config/policy.js';
import { chainIdSchema, observationSchema, poolSchema, json, errorMessage } from './domain.js';
import { PublicClients, smokeTest } from './clients/publicClients.js';
import { repository } from './storage/repositories.js';
import { Agent } from './workers/screeningWorker.js';
import { discover } from './workers/discoveryWorker.js';
import { demoObservations, DEMO_TIME } from './fixtures/demo.js';
import { renderReport } from './report.js';
import { deploymentPreflight } from './operations/preflight.js';
import { TelegramBot, telegramConfigFromEnv } from './telegram.js';
import { AgentRunRetrieval } from './agent/retrieval.js';
import { DecisionExplainer } from './agent/explainer.js';
import { CandidateAnalyst } from './agent/analyst.js';
import { createLlmClient } from './agent/llmClient.js';
import { ConversationalHandler } from './telegram/conversational.js';
import { SignerClient } from './execution/signerClient.js';

try { process.loadEnvFile?.(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const HELP = `Viero LP Agent (read-only and paper)

  npm run agent -- chains
  npm run agent -- preflight [--chains 4663,56,8453,5042]
  npm run agent -- smoke [--chains 4663,56,8453,5042]
  npm run agent -- discover [--chains 8453] [--token-limit 3] [--scan-from BLOCK]
  npm run agent -- screen [--chains 8453] [--seeds pools.json] [--pool-limit 10]
  npm run agent -- watch [--chains 8453] [--cycles 2]
  npm run agent -- live [--chains 8453] [--cycles 2]
  npm run agent -- telegram [--chains 8453]
  npm run agent -- demo [--out data/viero/demo-report.md]
  npm run agent -- replay observations.json [--out report.md]
  npm run agent -- report [--json]
  npm run agent -- pause [--chains 8453]
  npm run agent -- resume [--chains 8453]

Options: --config policy.json, --json, --out FILE, --help
GMGN requires GMGN_API_KEY. RPC overrides: VIERO_RPC_<chainId>.
Use VIERO_INDEXER_<chainId> for complete enriched observations.
Live mode talks only to the isolated local signer service; this process never reads a wallet key.`;

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    chains: { type: 'string' }, config: { type: 'string' }, seeds: { type: 'string' }, out: { type: 'string' },
    'token-limit': { type: 'string' }, 'pool-limit': { type: 'string' }, 'scan-from': { type: 'string' },
    cycles: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(HELP); return; }
  const chains = values.chains ? [...new Set(values.chains.split(',').map(v => chainIdSchema.parse(Number(v))))] : [...CHAIN_IDS];
  const policy = policySchema.parse(values.config ? JSON.parse(await readFile(values.config, 'utf8')) : {});
  const selected = values.chains ? chains : policy.enabledChains;
  const repo = repository();
  await repo.initialize();
  async function output(value: unknown, markdown?: string) {
    const text = values.json || !markdown ? json(value, true) : markdown;
    if (values.out) { const file = resolve(values.out); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text, { mode: 0o600 }); console.error(`Written: ${file}`); }
    console.log(text);
  }
  try {
    const signer = command === 'live' || command === 'telegram' ? new SignerClient() : undefined;
    const strategyLlm = command === 'live' || command === 'telegram' ? createLlmClient() : undefined;
    const agent = new Agent(policy, repo, undefined, signer, strategyLlm);
    const seeds = values.seeds ? z.array(poolSchema).parse(JSON.parse(await readFile(values.seeds, 'utf8'))) : [];
    const tokenLimit = z.coerce.number().int().min(1).max(100).parse(values['token-limit'] ?? 3);
    const poolLimit = z.coerce.number().int().min(1).max(1000).parse(values['pool-limit'] ?? 10);
    const scanFrom = values['scan-from'] ? BigInt(z.string().regex(/^\d+$/).parse(values['scan-from'])) : undefined;
    if (command === 'chains') { await output(selected.map(id => CHAINS[id])); return; }
    if (command === 'preflight') {
      const result = await deploymentPreflight({ chains: selected,
        smoke: chainId => smokeTest(agent.clients, chainId), gmgn: chainId => agent.gmgn.trending(chainId, '1h', 1) });
      await output(result); if (!result.ok) process.exitCode = 2; return;
    }
    if (command === 'smoke') {
      const clients = new PublicClients();
      const checks = await Promise.all(selected.map(async chainId => {
        try { return await smokeTest(clients, chainId); } catch (error) { return { chainId, ok: false, error: errorMessage(error) }; }
      }));
      await output(checks); if (checks.some(c => !c.ok)) process.exitCode = 2; return;
    }
    if (command === 'pause' || command === 'resume') {
      const controls = await repo.controls();
      if (!values.chains) controls.globalPaused = command === 'pause';
      else controls.pausedChains = command === 'pause' ? [...new Set([...controls.pausedChains, ...selected])] : controls.pausedChains.filter(c => !selected.includes(c));
      await repo.setControls(controls); await output(controls); return;
    }
    if (command === 'discover') { for (const chainId of selected) await output(await discover(chainId, agent, { tokenLimit, seeds, scanFrom })); return; }
    if (command === 'screen' || command === 'watch') {
      const cycles = command === 'screen' ? 1 : values.cycles ? z.coerce.number().int().min(1).parse(values.cycles) : Infinity;
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        for (let cycle = 0; cycle < cycles && !abort.signal.aborted; cycle++) {
          const controls = await repo.controls();
          const enabled = new Set(controls.enabledChains ?? []);
          const routineChains = selected.filter(chainId => enabled.has(chainId));
          const report = await agent.cycle({ mode: 'live-readonly', chains: routineChains, seeds, tokenLimit, poolLimit, scanFrom });
          await output(report, renderReport(report));
          if (command === 'screen' && report.status !== 'ok') process.exitCode = 2;
          if (cycle + 1 < cycles && !abort.signal.aborted) await delay(policy.screeningIntervalSeconds * 1000, undefined, { signal: abort.signal }).catch(e => { if (e.name !== 'AbortError') throw e; });
        }
      } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      }
      return;
    }
    if (command === 'live') {
      if (process.env.VIERO_EXECUTION_ENABLED !== 'true') throw new Error('LIVE_EXECUTION_NOT_ENABLED');
      await signer!.health();
      const cycles = values.cycles ? z.coerce.number().int().min(1).parse(values.cycles) : Infinity;
      const abort = new AbortController(), stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      let screened = 0, nextScreen = 0, nextManagement = 0;
      try {
        while (!abort.signal.aborted && screened < cycles) {
          const now = Date.now() / 1000;
          if (now >= nextManagement) {
            await output({ type: 'management', at: now, results: await agent.manageLive(now) });
            nextManagement = now + policy.managementIntervalSeconds;
          }
          if (now >= nextScreen) {
            const report = await agent.cycle({ mode: 'live-execution', chains: selected, seeds, tokenLimit, poolLimit, scanFrom });
            await output(report, renderReport(report)); screened++;
            nextScreen = Date.now() / 1000 + policy.screeningIntervalSeconds;
          }
          if (screened >= cycles) break;
          const waitSeconds = Math.max(1, Math.min(nextScreen, nextManagement) - Date.now() / 1000);
          await delay(waitSeconds * 1000, undefined, { signal: abort.signal }).catch(e => { if (e.name !== 'AbortError') throw e; });
        }
      } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      }
      return;
    }
    if (command === 'telegram') {
      const { token, allowedUserIds } = telegramConfigFromEnv();
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        console.error(`Telegram bot started for ${allowedUserIds.size} allowed user(s).`);
        // Viero is LLM-first: an API key (and a reachable base URL,
        // defaulting to OpenRouter) are required. createLlmClient throws
        // LLM_NOT_CONFIGURED when VIERO_LLM_API_KEY is missing.
        const llmClient = strategyLlm!;
        const explainer = new DecisionExplainer(llmClient);
        const analyst = new CandidateAnalyst(llmClient);
        const retrieval = new AgentRunRetrieval(repo);
        const conversational = new ConversationalHandler({ retrieval, explainer, analyst, llmClient });
        conversational.emitStartupBanner();
        await new TelegramBot({ token, allowedUserIds, agent, repo, chains: selected, tokenLimit, poolLimit, scanFrom,
          intervalSeconds: policy.screeningIntervalSeconds, signal: abort.signal,
          conversational, reportLlm: llmClient }).start();
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      return;
    }
    if (command === 'demo' || command === 'replay') {
      const windows = command === 'demo' ? [0, 1800, 3600].map(offset => demoObservations(DEMO_TIME + offset))
        : z.array(z.array(observationSchema)).nonempty().parse(JSON.parse(await readFile(z.string().min(1).parse(positionals[1]), 'utf8')));
      const result = await agent.replay(windows.map(window => window.filter(o => selected.includes(o.state.pool.chainId))));
      await output(result, renderReport(result.runs.at(-1)!) + `\nPaper net PnL: $${result.netPnlUsd.toFixed(4)}\n\n${result.note}\n`);
      return;
    }
    if (command === 'report') {
      const latest = await repo.latest(); if (!latest) throw new Error('No saved report; run demo or screen first');
      await output(latest, renderReport(latest)); return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally { await repo.close(); }
}
main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
