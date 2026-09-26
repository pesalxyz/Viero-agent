import { z } from 'zod';
import { type Candidate } from '../screening/pipeline.js';

export const PROMPT_VERSION = 'bounded-agent-1';
const selectionSchema = z.object({ action: z.enum(['hold', 'preview']), candidateId: z.string().optional(), reason: z.string().min(1).max(1000) }).strict();
export type Selection = z.infer<typeof selectionSchema>;
export interface DecisionModel { choose(input: { promptVersion: string; role: 'screener'; candidates: Array<{ id: string; score: number | null; expectedNetFeesUsd: number | null }> }): Promise<unknown> }
export async function selectCandidate(candidates: Candidate[], model?: DecisionModel): Promise<Selection> {
  const approved = candidates.filter(c => c.approved);
  if (!approved.length) return { action: 'hold', reason: 'No candidate passed deterministic policy' };
  if (!model) return { action: 'preview', candidateId: approved[0]!.identity, reason: 'Highest globally ranked approved candidate' };
  const selection = selectionSchema.parse(await model.choose({ promptVersion: PROMPT_VERSION, role: 'screener',
    candidates: approved.map(c => ({ id: c.identity, score: c.globalScore, expectedNetFeesUsd: c.metrics.expectedNetFeesUsd })) }));
  if (selection.action === 'preview' && !approved.some(c => c.identity === selection.candidateId)) throw new Error('MODEL_SELECTED_UNAPPROVED_POOL');
  if (selection.action === 'hold' && selection.candidateId) throw new Error('HOLD_CANNOT_SELECT_POOL');
  return selection;
}
export const ROLE_TOOLS = {
  screener: ['list_supported_chains', 'discover_pools', 'verify_pool', 'get_top_candidates', 'get_pool_metrics', 'preview_position'],
  manager: ['get_positions', 'get_position_pnl', 'evaluate_position'],
} as const;
export function assertRoleTool(role: keyof typeof ROLE_TOOLS, tool: string) {
  if (!(ROLE_TOOLS[role] as readonly string[]).includes(tool)) throw new Error('ROLE_TOOL_DENIED');
}
