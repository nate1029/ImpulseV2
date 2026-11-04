// EmbedBench's report as a page a person reads (bench/reports/*.md).
//
//   node scripts/embedbench-report.mjs bench/reports/<name>.json   # writes <name>.md next to it
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The report as a page a person reads: the variants, the boards, and why each failure failed. */
export function markdownReport(r) {
  const lines = [`# ${r.bench}: ${r.label}`, '', `${r.date.slice(0, 16).replace('T', ' ')} UTC${r.model ? `, ${r.model} (reasoning ${r.reasoning})` : ''}.`, ''];
  lines.push('| Variant | Passed | Built and ran | Cost (USD) | Cost per working sketch |', '|---|---|---|---|---|');
  for (const [v, x] of Object.entries(r.summary)) {
    lines.push(`| ${v} | ${x.passed}/${x.tasks} (${x.passRate} %) | ${x.compiled}/${x.tasks} | ${x.costUsd.toFixed(4)} | ${x.costPerWorkingSketchUsd === null ? '–' : x.costPerWorkingSketchUsd.toFixed(4)} |`);
  }
  const variants = Object.keys(r.summary);
  lines.push('', `| Board | ${variants.join(' | ')} |`, `|---|${variants.map(() => '---').join('|')}|`);
  for (const [b, per] of Object.entries(r.byBoard)) lines.push(`| ${b} | ${variants.map((v) => per[v] || '–').join(' | ')} |`);
  const failed = r.results.filter((x) => !x.ok);
  lines.push('', `## Failures (${failed.length})`, '');
  for (const f of failed) lines.push(`- **${f.id}** (${f.variant}): ${String(f.error || '').replace(/\|/g, '/').slice(0, 240)}`);
  if (r.skipped?.length) lines.push('', `Skipped: ${r.skipped.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/embedbench-report.mjs <report.json>');
    process.exit(2);
  }
  const out = file.replace(/\.json$/, '.md');
  fs.writeFileSync(out, markdownReport(JSON.parse(fs.readFileSync(file, 'utf8'))));
  console.log(`Wrote ${out}`);
}
