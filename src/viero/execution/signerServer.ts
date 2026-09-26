#!/usr/bin/env node
import express from 'express';
import { chmod, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { errorMessage, json, observationSchema } from '../domain.js';
import { LiveExecutor } from './executor.js';
import { livePositionSchema, positionPlanSchema } from './liveState.js';
import { policySchema } from '../config/policy.js';

try { process.loadEnvFile?.(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
if (process.env.VIERO_EXECUTION_ENABLED !== 'true') throw new Error('LIVE_EXECUTION_NOT_ENABLED');
const executor = new LiveExecutor();
const policyBody = z.object({ policy: policySchema }).strict();
const app = express();

// Provider failures (notably Relay quote failures during normalization) must
// remain request-scoped.  Keep the isolated signer alive so unrelated close
// requests can still be served.
process.on('unhandledRejection', (reason) => {
  console.error('[viero-signer] unhandled rejection contained', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[viero-signer] uncaught exception contained', error);
});

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, address: executor.wallets.account.address }));
app.post('/v1/balances', async (req, res, next) => {
  try {
    const body = z.object({ chainId: z.union([z.literal(4663), z.literal(56), z.literal(8453), z.literal(5042)]), tokens: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)) }).strict().parse(req.body);
    const balances = await executor.balances(body.chainId, body.tokens as `0x${string}`[]);
    res.type('application/json').send(json({ native: balances.native, tokens: [...balances.tokens] }));
  } catch (error) { next(error); }
});
app.post('/v1/open', async (req, res, next) => {
  try {
    const body = z.object({ plan: positionPlanSchema, observation: observationSchema }).merge(policyBody).strict().parse(req.body);
    executor.setPolicy(body.policy);
    res.type('application/json').send(json(await executor.open(body.plan, body.observation)));
  } catch (error) { next(error); }
});
app.post('/v1/claim', async (req, res, next) => {
  try { res.type('application/json').send(json(await executor.claim(z.object({ position: livePositionSchema }).strict().parse(req.body).position))); }
  catch (error) { next(error); }
});
app.post('/v1/close', async (req, res, next) => {
  try {
    const body = z.object({ position: livePositionSchema, observation: observationSchema, emergency: z.boolean().default(false) }).merge(policyBody).strict().parse(req.body);
    executor.setPolicy(body.policy);
    res.type('application/json').send(json(await executor.close(body.position, body.observation, body.emergency)));
  } catch (error) { next(error); }
});
app.post('/v1/normalize', async (req, res, next) => {
  try {
    res.type('application/json').send(json(await executor.normalize(z.object({ position: livePositionSchema }).strict().parse(req.body).position)));
  } catch (error) {
    const message = errorMessage(error);
    const code = typeof error === 'object' && error !== null && 'rawError' in error
      ? String((error as { rawError?: { errorCode?: unknown } }).rawError?.errorCode ?? '') || undefined
      : undefined;
    console.error(`[viero-signer] normalization failed${code ? ` code=${code}` : ''}: ${message}`);
    res.status(503).json({ error: message, ...(code ? { code } : {}) });
  }
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof z.ZodError ? 400 : 503).json({ error: errorMessage(error) }));

const socket = process.env.VIERO_SIGNER_SOCKET ?? '/run/viero-signer/viero.sock';
await unlink(socket).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
const server = app.listen(socket, async () => { await chmod(socket, 0o660); console.log(`Viero signer listening on ${socket}`); });
const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
