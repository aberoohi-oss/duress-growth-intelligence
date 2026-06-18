require('dotenv').config();

const googleAds    = require('./src/services/googleAds');
const microsoftAds = require('./src/services/microsoftAds');
const hubspot      = require('./src/services/hubspot');
const { mergeCampaigns } = require('./src/utils/attribution');

const MONTHS = [
  ['2025-02-01','2025-02-28','FEB 2025'],
  ['2025-03-01','2025-03-31','MAR 2025'],
  ['2025-04-01','2025-04-30','APR 2025'],
  ['2025-05-01','2025-05-31','MAY 2025'],
  ['2025-06-01','2025-06-30','JUN 2025'],
  ['2025-07-01','2025-07-31','JUL 2025'],
  ['2025-08-01','2025-08-31','AUG 2025'],
  ['2025-09-01','2025-09-30','SEP 2025'],
  ['2025-10-01','2025-10-31','OCT 2025'],
  ['2025-11-01','2025-11-30','NOV 2025'],
  ['2025-12-01','2025-12-31','DEC 2025'],
  ['2026-01-01','2026-01-31','JAN 2026'],
  ['2026-02-01','2026-02-28','FEB 2026'],
  ['2026-03-01','2026-03-31','MAR 2026'],
  ['2026-04-01','2026-04-30','APR 2026'],
  ['2026-05-01','2026-05-31','MAY 2026'],
  ['2026-06-01','2026-06-30','JUN 2026'],
];

const EMPTY_REV = { pipelineValue: 0, closedRevenue: 0, wonDealCount: 0 };

async function fetchMonth(start, end) {
  const [gRes, bRes, hsRes, revRes] = await Promise.allSettled([
    googleAds.getCampaigns(start, end),
    microsoftAds.getCampaigns(start, end),
    hubspot.getLeads(start, end),
    hubspot.getDealRevenue(start, end),
  ]);

  const gCamps   = gRes.status   === 'fulfilled' ? gRes.value   : [];
  const bCamps   = bRes.status   === 'fulfilled' ? bRes.value   : [];
  const contacts = hsRes.status  === 'fulfilled' ? hsRes.value  : [];
  const rev      = revRes.status === 'fulfilled' ? revRes.value : { pipelineValue: 0, paidPipelineValue: 0, closedRevenue: 0 };

  const googleSpend = gCamps.reduce((s, c) => s + (c.spend || 0), 0);
  const bingSpend   = bCamps.reduce((s, c) => s + (c.spend || 0), 0);

  const { campaigns } = mergeCampaigns([...gCamps, ...bCamps], contacts, { pipelineValue: 0, closedRevenue: 0, wonDealCount: 0 });
  const paidLeads = campaigns.reduce((s, c) => s + (c.leads || 0), 0);

  const directLeads  = contacts.filter(c =>
    (c.properties?.hs_analytics_source || '').toUpperCase() === 'DIRECT_TRAFFIC'
  ).length;
  const organicLeads = contacts.filter(c =>
    (c.properties?.hs_analytics_source || '').toUpperCase() === 'ORGANIC_SEARCH'
  ).length;

  const totalSpend       = googleSpend + bingSpend;
  const paidPipelineValue = rev.paidPipelineValue || 0;
  const closedRevenue    = rev.closedRevenue || 0;
  const roas             = totalSpend > 0 && closedRevenue > 0 ? closedRevenue / totalSpend : null;

  return { googleSpend, bingSpend, totalSpend, paidLeads, directLeads, organicLeads, paidPipelineValue, closedRevenue, roas };
}

async function main() {
  const rows = [];

  for (const [start, end, label] of MONTHS) {
    process.stderr.write(`  fetching ${label}...\n`);
    try {
      rows.push({ label, ...(await fetchMonth(start, end)) });
    } catch (err) {
      process.stderr.write(`  ERROR ${label}: ${err.message}\n`);
      rows.push({ label, googleSpend: 0, bingSpend: 0, totalSpend: 0, paidLeads: 0, directLeads: 0, organicLeads: 0 });
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  const f$ = v => v ? '$' + Math.round(v).toLocaleString('en-AU') : '$0';
  const fN = v => v ? String(v) : '0';
  const fX = v => v != null ? v.toFixed(2) + 'x' : '—';

  const cols  = ['MONTH', 'Total Spend', 'Paid Leads', 'Direct', 'Organic', 'Paid Pipeline', 'Closed Revenue', 'ROAS'];
  const widths = [12,      13,            12,           9,        10,        16,               16,               8];

  const pad = (s, w) => String(s).padStart(w);
  const line = row => row.map((v, i) => (i === 0 ? String(v).padEnd(widths[0]) : pad(v, widths[i]))).join('  ');

  const sep = '-'.repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 2);

  const lines = [line(cols), sep];
  for (const r of rows) {
    lines.push(line([
      r.label,
      f$(r.totalSpend),
      fN(r.paidLeads),
      fN(r.directLeads),
      fN(r.organicLeads),
      f$(r.paidPipelineValue),
      f$(r.closedRevenue),
      fX(r.roas),
    ]));
  }
  lines.push(sep);

  const fs = require('fs');
  const out = lines.join('\n') + '\n';
  fs.writeFileSync('board-data-output.txt', out);
  process.stderr.write(`\nWrote board-data-output.txt\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
