import { request } from 'node:http';
import { z } from 'zod';
import { addressSchema, chainIdSchema, json, observationSchema, type ChainId, type Observation } from '../domain.js';
import { executionTransactionSchema, livePositionSchema, positionPlanSchema, type LivePosition } from './liveState.js';
import { type PositionPlan } from './planner.js';
import { type Policy } from '../config/policy.js';

const resultSchema = z.object({ value: livePositionSchema, transactions: z.array(executionTransactionSchema) });
export class SignerClient {
  constructor(readonly socket = process.env.VIERO_SIGNER_SOCKET ?? '/run/viero-signer/viero.sock') {}
  private call(path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : json(body);
      const req = request({ socketPath: this.socket, path, method: payload ? 'POST' : 'GET', headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string };
            if (!res.statusCode || res.statusCode >= 300) reject(new Error(value.error ?? `SIGNER_HTTP_${res.statusCode}`)); else resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject); req.setTimeout(190_000, () => req.destroy(new Error('SIGNER_TIMEOUT')));
      if (payload) req.write(payload); req.end();
    });
  }
  async health() { return z.object({ ok: z.literal(true), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await this.call('/health')); }
  async balances(chainId: ChainId, tokens: `0x${string}`[]) {
    const value = z.object({ native: z.string().regex(/^\d+$/).transform(BigInt), tokens: z.array(z.tuple([addressSchema, z.string().regex(/^\d+$/).transform(BigInt)])) })
      .parse(await this.call('/v1/balances', { chainId: chainIdSchema.parse(chainId), tokens: tokens.map(token => addressSchema.parse(token)) }));
    return { native: value.native, tokens: new Map(value.tokens) };
  }
  async open(plan: PositionPlan, observation: Observation, policy: Policy) {
    return resultSchema.parse(await this.call('/v1/open',
      { plan: positionPlanSchema.parse(plan), observation: observationSchema.parse(observation), policy }));
  }
  async claim(position: LivePosition) { return resultSchema.parse(await this.call('/v1/claim', { position: livePositionSchema.parse(position) })); }
  async close(position: LivePosition, observation: Observation, policy: Policy, emergency = false) {
    return resultSchema.parse(await this.call('/v1/close',
      { position: livePositionSchema.parse(position), observation: observationSchema.parse(observation), emergency, policy }));
  }
  async normalize(position: LivePosition) {
    return resultSchema.parse(await this.call('/v1/normalize', { position: livePositionSchema.parse(position) }));
  }
}
