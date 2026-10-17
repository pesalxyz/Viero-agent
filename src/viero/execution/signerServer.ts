#!/usr/bin/env node
import express from 'express';
import { chmod, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { errorMessage, json, observationSchema, structuredExecutionError } from '../domain.js';
import { LiveExecutor } from './executor.js';
import { livePositionSchema, positionPlanSchema } from './liveState.js';
import { policySchema } from '../config/policy.js';
import { defaultRpcTelemetry } from '../observability/rpcTelemetry.js';

/** The same production router is mounted by the signer and disposable socket harness. */
export function createSignerApp(executor: LiveExecutor, recoveryReadiness: Awaited<ReturnType<LiveExecutor['startupRecovery']>>) {
const policyBody = z.object({ policy: policySchema }).strict();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, address: executor.wallets.account.address,
  recovery: recoveryReadiness.state, relayRecovery: executor.relay?.recoveryStatus() ?? { state: 'NOT_CONFIGURED', unresolved: 0 } }));
const requireRecoveryReady = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  // A durable V3 close workflow may be resumed through the normal close path:
  // executor.close performs fresh pool/price/finality checks before collect.
  if (recoveryReadiness.state !== 'READY' && _req.path !== '/v1/close') return res.status(503).json({ error: 'SIGNER_RECOVERY_NOT_READY', state: recoveryReadiness.state });
  next();
};
app.post('/v1/balances', async (req, res, next) => {
  try {
    const body = z.object({ chainId: z.union([z.literal(4663), z.literal(56), z.literal(8453), z.literal(5042)]), tokens: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)) }).strict().parse(req.body);
    const balances = await defaultRpcTelemetry.run('execution-receipt', () => executor.balances(body.chainId, body.tokens as `0x${string}`[]));
    res.type('application/json').send(json({ native: balances.native, tokens: [...balances.tokens] }));
  } catch (error) { next(error); }
});
// Agent projection acknowledgement is a signer-owned, transaction-free mutation.
// It is intentionally available while recovery is held so an agent can repair a
// confirmed mint without authorizing another transaction.
app.post('/v1/ack-position', async (req, res, next) => {
  try {
    const body = z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), positionId: z.string().min(1).max(300) }).strict().parse(req.body);
    res.type('application/json').send(json(executor.acknowledgePositionProjection(body.transactionHash as `0x${string}`, body.positionId)));
  } catch (error) { next(error); }
});
app.get('/v1/recovery/open-positions', (_req, res) => {
  res.type('application/json').send(json(executor.operationStore.unacknowledgedOpenOperations().map(operation => ({ operationId: operation.operationId, transactionHash: operation.transactionHash, positionEvidence: operation.positionEvidence }))));
});
app.post('/v1/open', requireRecoveryReady, async (req, res, next) => {
  try {
    const body = z.object({ plan: positionPlanSchema, observation: observationSchema }).merge(policyBody).strict().parse(req.body);
    executor.setPolicy(body.policy);
    res.type('application/json').send(json(await defaultRpcTelemetry.run('execution-receipt', () => executor.open(body.plan, body.observation))));
  } catch (error) { next(error); }
});
app.post('/v1/claim', requireRecoveryReady, async (req, res, next) => {
  try { res.type('application/json').send(json(await defaultRpcTelemetry.run('execution-receipt', () => executor.claim(z.object({ position: livePositionSchema }).strict().parse(req.body).position)))); }
  catch (error) { next(error); }
});
app.post('/v1/close', requireRecoveryReady, async (req, res, next) => {
  try {
    const body = z.object({ position: livePositionSchema, observation: observationSchema, emergency: z.boolean().default(false) }).merge(policyBody).strict().parse(req.body);
    executor.setPolicy(body.policy);
    res.type('application/json').send(json(await defaultRpcTelemetry.run('execution-receipt', () => executor.close(body.position, body.observation, body.emergency))));
  } catch (error) { next(error); }
});
app.post('/v1/normalize', requireRecoveryReady, async (req, res, next) => {
  try {
    if (executor.relay && executor.relay.recoveryStatus().state !== 'READY') return res.status(503).json({ error: 'RELAY_RECOVERY_NOT_READY' });
    res.type('application/json').send(json(await defaultRpcTelemetry.run('normalization', () => executor.normalize(z.object({ position: livePositionSchema }).strict().parse(req.body).position))));
  } catch (error) {
    const message = errorMessage(error);
    const code = typeof error === 'object' && error !== null && 'rawError' in error
      ? String((error as { rawError?: { errorCode?: unknown } }).rawError?.errorCode ?? '') || undefined
      : undefined;
    console.error(`[viero-signer] normalization failed${code ? ` code=${code}` : ''}: ${message}`);
    res.status(503).json({ error: message, ...(code ? { code } : {}) });
  }
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const structured = structuredExecutionError(error);
  res.status(error instanceof z.ZodError ? 400 : 503).json({ error: structured.message, ...(structured.code ? { code: structured.code } : {}), ...(structured.details ? { details: structured.details } : {}) });
});
return app;
}

async function main() {
try { process.loadEnvFile?.(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
if (process.env.VIERO_EXECUTION_ENABLED !== 'true') throw new Error('LIVE_EXECUTION_NOT_ENABLED');
const executor = new LiveExecutor();
const recoveryReadiness = await executor.startupRecovery();
console.error(`[viero-signer] startup recovery state=${recoveryReadiness.state}${recoveryReadiness.reason ? ` reason=${recoveryReadiness.reason}` : ''}`);
// Provider failures must remain request-scoped so unrelated close requests can be served.
process.on('unhandledRejection', reason => console.error('[viero-signer] unhandled rejection contained', reason));
process.on('uncaughtException', error => console.error('[viero-signer] uncaught exception contained', error));
const app = createSignerApp(executor, recoveryReadiness);
const socket = process.env.VIERO_SIGNER_SOCKET ?? '/run/viero-signer/viero.sock';
await unlink(socket).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
const server = app.listen(socket, async () => { await chmod(socket, 0o660); console.log(`Viero signer listening on ${socket}`); });
const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
