// What the job shows at the end: annotations and the job summary, from the report depi-proxy writes
// when it stops (activity.rs, schema 2). npm decided the outcome already (a refused download fails
// the install): this only explains it.
import * as gh from './lib.mjs';

const nf = new Intl.NumberFormat('en-US');
const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const sevIcon = (s) => ({ critical: '🟥', high: '🟧', medium: '🟨', low: '🟦' })[String(s ?? '').toLowerCase()] ?? '⬜';

/** Annotations GitHub shows per step; the rest is in the summary. */
export const MAX_ANNOTATIONS = 10;
/** Rows of the summary table (GitHub caps a job summary at 1 MiB). */
export const MAX_ROWS = 1000;

/** Each event of the report (activity.rs `type` and `status`), most serious first. */
const STATUSES = {
  'install error': { label: '❌ not served', refused: true },
  'listing error': { label: '❌ not served', refused: true },
  'install blocked': { label: '❌ refused', refused: true },
  'listing patched': { label: '❌ versions withheld', refused: true },
  'install warned': { label: '⚠️ would be refused (`warn`)', warn: true },
  'listing warned': { label: '⚠️ versions would be withheld (`warn`)', warn: true },
  'install unavailable': { label: '⚠️ served without a Depi check', warn: true },
  'listing unavailable': { label: '⚠️ served without a Depi check', warn: true },
};
const meta = (e) => STATUSES[`${e.type} ${e.status}`];
const rank = (e) => {
  const i = Object.keys(STATUSES).indexOf(`${e.type} ${e.status}`);
  return i < 0 ? Object.keys(STATUSES).length : i;
};

/** The package as npm names it: `name@version` for an install. */
export const packageOf = (e) => (e.type === 'install' && e.version ? `${e.package}@${e.version}` : e.package);

/** Why: the versions a listing removed, else the event's detail. */
export function why(e) {
  const parts = [];
  if (e.malware_versions?.length) parts.push(`${e.malware_versions.join(', ')} · known malware`);
  if (e.cooldown_versions?.length) parts.push(`${e.cooldown_versions.join(', ')}${e.detail ? ` · ${e.detail}` : ''}`);
  return parts.length ? parts.join(' — ') : (e.detail ?? '');
}

/** No tarball went through the proxy: what was installed, if anything, came from a cache or another registry (normal with a full cache). */
const BYPASSED = 'no package was downloaded through depi-proxy in this job: if it installed packages, they came from a restored cache or another registry';
export const bypassed = (report) => Boolean(report) && !report.counters?.tarball_allowed && !report.counters?.tarball_blocked;

/** The job summary, as Markdown. `report` is null when depi-proxy left none (it did not stop cleanly). */
export function render(report, enforcement) {
  if (!report) return '### ⚠️ depi-proxy: no report\n\ndepi-proxy did not write its report: see its log at the end of the job.\n';
  const events = [...(report.events ?? [])].sort((a, b) => rank(a) - rank(b) || packageOf(a).localeCompare(packageOf(b)));
  // Packages, not events: a withheld listing and a refused download of one package are one.
  const packages = (flag) => new Set(events.filter((e) => meta(e)?.[flag]).map((e) => e.package)).size;
  const refused = packages('refused');
  const warned = packages('warn');
  const c = report.counters ?? {};
  let title;
  if (refused) title = `❌ depi-proxy: ${plural(refused, 'package')} refused`;
  else if (warned) title = `⚠️ depi-proxy: ${plural(warned, 'package')} to look at (${enforcement === 'warn' ? '`warn` mode' : 'served'})`;
  else title = `✅ depi-proxy: nothing blocked`;
  const out = [`### ${title}`, ''];
  out.push(`${plural(c.tarball_allowed ?? 0, 'tarball')} served through the proxy.`, '');
  if (bypassed(report)) out.push(`> ℹ️ ${BYPASSED[0].toUpperCase()}${BYPASSED.slice(1)}.`, '');
  if (events.length) {
    out.push('| Package | | Severity | Why |', '|---|---|---|---|');
    for (const e of events.slice(0, MAX_ROWS)) {
      out.push(`| \`${esc(packageOf(e))}\` | ${meta(e)?.label ?? esc(`${e.type} ${e.status}`)} | ${e.severity ? `${sevIcon(e.severity)} ${esc(e.severity)}` : '—'} | ${esc(why(e))} |`);
    }
    if (events.length > MAX_ROWS) out.push('', `…and ${nf.format(events.length - MAX_ROWS)} more.`);
    out.push('');
  }
  const t = report.added_latency_us?.tarball;
  out.push(`<sub>[depi-proxy](https://github.com/Depi-Security/depi-proxy-action) · enforcement: \`${enforcement}\`${t ? ` · added latency p99 ${t.p99} µs` : ''}</sub>`);
  return out.join('\n') + '\n';
}

/** Annotations (only what needs attention) and the job summary. */
export function report(report, enforcement) {
  const shown = (report?.events ?? []).filter((e) => meta(e)).sort((a, b) => rank(a) - rank(b));
  for (const e of shown.slice(0, MAX_ANNOTATIONS)) {
    (meta(e).refused ? gh.error : gh.warning)(`${packageOf(e)}: ${why(e)}`, { title: `depi-proxy: ${meta(e).label.replace(/^\S+ /, '')}` });
  }
  if (shown.length > MAX_ANNOTATIONS) gh.warning(`…and ${shown.length - MAX_ANNOTATIONS} more: see the job summary`);
  if (!report) gh.warning('depi-proxy did not write its report: see its log at the end of the job');
  if (bypassed(report)) gh.notice(BYPASSED);
  gh.summary(render(report, enforcement));
}
