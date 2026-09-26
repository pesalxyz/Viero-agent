import { getChain } from './config/chains.js';
import { type AgentRun } from './storage/repositories.js';

const money = (value: number | null) => value === null ? 'unavailable' : `$${value.toFixed(4)}`;
export function renderReport(run: AgentRun): string {
  const lines = [
    `# Viero ${run.mode === 'replay' ? 'Synthetic / Replay' : 'Read-Only'} Report`, '',
    `Run: ${run.id}`, `Status: ${run.status}`, `Time: ${new Date(run.startedAt * 1000).toISOString()}`,
    `Policy: ${run.configVersion}; deployments: ${run.deploymentVersion}`, '',
    'No signing or transaction broadcasting is available in this release.', '',
    '| Chain | Venue | Protocol | Pool | Result | Volume / 30m | LP fees | 1% depth | Net fee estimate | Score |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const c of run.candidates) lines.push(`| ${getChain(c.pool.chainId).name} | ${c.pool.dex} | ${c.pool.protocol} | ${c.identity} | ${c.approved ? 'Approved for preview' : 'Rejected'} | ${money(c.metrics.volumeUsd)} | ${money(c.metrics.lpFeesUsd)} | ${money(c.metrics.depthUsd)} | ${money(c.metrics.expectedNetFeesUsd)} | ${c.globalScore?.toFixed(4) ?? '-'} |`);
  lines.push('', '## Decisions', '');
  for (const d of run.decisions) lines.push(`- ${getChain(d.chainId).name}: ${d.selection.action}. ${d.selection.reason}${d.plan ? ` Paper budget ${money(d.plan.depositUsd)}, ticks ${d.plan.tickLower} to ${d.plan.tickUpper}.` : ''}`);
  if (run.candidates.some(c => !c.approved)) {
    lines.push('', '## Rejections', '');
    for (const c of run.candidates.filter(c => !c.approved)) lines.push(`- ${c.identity}: ${c.rejections.map(r => `${r.code} (${r.detail})`).join('; ')}`);
  }
  if (run.errors.length) { lines.push('', '## Data Gaps', ''); for (const e of run.errors) lines.push(`- ${e.chainId}${e.pool ? ` ${e.pool}` : ''}: ${e.error}`); }
  if (run.positions.length) {
    lines.push('', '## Paper Positions', '', '| Chain | Status | Net PnL | Unclaimed fees | Last action |', '| --- | --- | ---: | ---: | --- |');
    for (const p of run.positions) lines.push(`| ${getChain(p.chainId).name} | ${p.status} | ${money(p.netPnlUsd)} | ${money(p.unclaimedFeesUsd)} | ${p.events.at(-1)?.action ?? '-'} |`);
  }
  lines.push('', 'Exact inputs, source blocks, score components, and rejection details are preserved in the JSON run record.', '');
  return lines.join('\n');
}
