(() => {
'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
const S = {
  dateRange: 'this_month',
  customStart: '',
  customEnd: '',
  country: 'all',
  channel: 'all',
  campaign: 'all',
  compare: false,
  data: null,
  prevData: null,
  sortCol: 'spend',
  sortDir: 'desc',
  searchTerm: '',
  loading: false,
};

const CHARTS = {};

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmtMoney(v) {
  if (v == null || isNaN(v)) return '—';
  return '$' + Math.round(v).toLocaleString('en-AU');
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return (v * 100).toFixed(1) + '%';
}
function fmtNum(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v).toLocaleString('en-AU');
}
function fmtX(v) {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(2) + 'x';
}

// ─── Date utilities ───────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(start, end) {
  return Math.round((new Date(end) - new Date(start)) / 86400000);
}
function pad(n) { return String(n).padStart(2, '0'); }

function getDateRange() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;

  switch (S.dateRange) {
    case 'this_month':
      return { start: `${y}-${pad(m)}-01`, end: todayStr() };

    case 'last_month': {
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      return { start: `${ly}-${pad(lm)}-01`, end: `${ly}-${pad(lm)}-${pad(daysInMonth(ly, lm))}` };
    }

    case 'this_quarter': {
      const qs = Math.floor((m - 1) / 3) * 3 + 1;
      return { start: `${y}-${pad(qs)}-01`, end: todayStr() };
    }

    case 'last_quarter': {
      const qs = Math.floor((m - 1) / 3) * 3 + 1;
      const lqe = qs === 1 ? 12 : qs - 1;
      const lqs = lqe - 2;
      const lqy = qs === 1 ? y - 1 : y;
      return { start: `${lqy}-${pad(lqs)}-01`, end: `${lqy}-${pad(lqe)}-${pad(daysInMonth(lqy, lqe))}` };
    }

    case 'custom':
      return { start: S.customStart || `${y}-${pad(m)}-01`, end: S.customEnd || todayStr() };

    default:
      return { start: `${y}-${pad(m)}-01`, end: todayStr() };
  }
}

function getPrevDateRange(start, end) {
  const days = diffDays(start, end) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return { start: prevStart, end: prevEnd };
}

function getPeriodLabel() {
  const labels = {
    this_month: 'This Month', last_month: 'Last Month',
    this_quarter: 'This Quarter', last_quarter: 'Last Quarter',
    custom: 'Custom Range',
  };
  return labels[S.dateRange] || 'Custom';
}

// ─── Geo detection ────────────────────────────────────────────────────────────
function detectGeo(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  if (/\bAU\b|-AU\b|_AU\b/.test(n)) return 'AU';
  if (/\bNZ\b|-NZ\b|_NZ\b/.test(n)) return 'NZ';
  if (/\bUK\b|-UK\b|_UK\b/.test(n)) return 'UK';
  return null;
}

// ─── Filter logic ─────────────────────────────────────────────────────────────
function applyFilters(campaigns) {
  let f = campaigns || [];

  if (S.channel !== 'all') {
    const src = S.channel === 'google' ? 'google' : 'bing';
    f = f.filter(c => c.source === src);
  }

  if (S.country !== 'all') {
    f = f.filter(c => (c.geo || detectGeo(c.name)) === S.country);
  }

  if (S.campaign !== 'all') {
    f = f.filter(c => c.id === S.campaign || c.name === S.campaign);
  }

  if (S.searchTerm) {
    const t = S.searchTerm.toLowerCase();
    f = f.filter(c => c.name.toLowerCase().includes(t));
  }

  return f;
}

function recalcTotals(filtered) {
  if (!filtered.length) {
    return { spend: 0, clicks: 0, impressions: 0, leads: 0, closedWonDeals: 0,
      pipelineValue: 0, closedRevenue: 0, cpl: 0, cac: 0, roas: 0, roi: 0, ctr: 0 };
  }

  const t = filtered.reduce((acc, c) => {
    acc.spend         += c.spend || 0;
    acc.clicks        += c.clicks || 0;
    acc.impressions   += c.impressions || 0;
    acc.leads         += c.leads || 0;
    acc.closedWonDeals+= c.closedWonDeals || 0;
    acc.pipelineValue += c.pipelineValue || 0;
    acc.closedRevenue += c.closedRevenue || 0;
    return acc;
  }, { spend:0, clicks:0, impressions:0, leads:0, closedWonDeals:0, pipelineValue:0, closedRevenue:0 });

  t.cpl  = t.leads          > 0 ? t.spend / t.leads : 0;
  t.cac  = t.closedWonDeals > 0 ? t.spend / t.closedWonDeals : 0;
  t.roas = t.spend          > 0 ? t.closedRevenue / t.spend : 0;
  t.roi  = t.spend          > 0 ? (t.closedRevenue - t.spend) / t.spend : 0;
  t.ctr  = t.impressions    > 0 ? t.clicks / t.impressions : 0;
  return t;
}

function getFilteredTimeSeries(ts, filtered, all) {
  if (!ts) return { daily: [], weekly: [] };

  const sum    = arr => (arr || []).reduce((s, c) => s + (c.spend || 0), 0);
  const allSpend  = sum(all);
  const filtSpend = sum(filtered);
  const ratio     = allSpend > 0 ? filtSpend / allSpend : 1;

  const gAll  = sum((all || []).filter(c => c.source === 'google'));
  const bAll  = sum((all || []).filter(c => c.source === 'bing'));
  const gFilt = sum(filtered.filter(c => c.source === 'google'));
  const bFilt = sum(filtered.filter(c => c.source === 'bing'));
  const gRatio = gAll > 0 ? gFilt / gAll : (S.channel === 'bing' ? 0 : 1);
  const bRatio = bAll > 0 ? bFilt / bAll : (S.channel === 'google' ? 0 : 1);

  const scale = arr => (arr || []).map(d => ({
    ...d,
    googleSpend: (d.googleSpend || 0) * gRatio,
    bingSpend:   (d.bingSpend   || 0) * bRatio,
    spend:       (d.googleSpend || 0) * gRatio + (d.bingSpend || 0) * bRatio,
    leads:       (d.leads       || 0) * ratio,
    revenue:     (d.revenue     || 0) * ratio,
  }));

  return { daily: scale(ts.daily), weekly: scale(ts.weekly) };
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function fetchData(start, end, forceRefresh = false) {
  const p = new URLSearchParams({ startDate: start, endDate: end });
  if (forceRefresh) p.set('refresh', 'true');
  const res = await fetch(`/api/analytics?${p}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function setText(id, v) { const e = el(id); if (e) e.textContent = v; }

// ─── KPI rendering ────────────────────────────────────────────────────────────
function pctChange(curr, prev) {
  if (prev == null || prev === 0) return null;
  return (curr - prev) / Math.abs(prev);
}

function compareBadgeHTML(curr, prev, lowerIsBetter) {
  const pct = pctChange(curr, prev);
  if (pct === null) return '';
  const improved = lowerIsBetter ? pct < 0 : pct > 0;
  const cls = Math.abs(pct) < 0.005 ? 'badge-neutral' : (improved ? 'badge-up' : 'badge-down');
  const sign = pct > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${(pct * 100).toFixed(1)}% vs prev</span>`;
}

function renderKPIs(totals, prevTotals, dealRevenue, prevDeal) {
  const dr = dealRevenue || {};
  const pd = prevDeal   || {};

  setText('val-spend',    fmtMoney(totals.spend));
  setText('val-leads',    fmtNum(totals.leads));
  setText('val-cpl',      fmtMoney(totals.cpl));
  setText('val-cac',      fmtMoney(totals.cac));
  setText('val-pipeline', fmtMoney(dr.pipelineValue));
  setText('val-revenue',  fmtMoney(dr.closedRevenue));
  setText('val-roas',     fmtX(totals.roas));
  setText('val-roi',      totals.roi != null && !isNaN(totals.roi) ? (totals.roi * 100).toFixed(0) + '%' : '—');

  setText('sub-spend',    S.channel === 'all' ? 'All channels' : (S.channel === 'google' ? 'Google Ads' : 'Microsoft Ads'));
  setText('sub-pipeline', `${dr.openDealCount || 0} open deals`);
  setText('sub-revenue',  `${dr.wonDealCount  || 0} closed won`);

  const showCmp = S.compare && prevTotals;
  const cmpMap = {
    spend:    [totals.spend,        prevTotals && prevTotals.spend,        false],
    leads:    [totals.leads,        prevTotals && prevTotals.leads,        false],
    cpl:      [totals.cpl,          prevTotals && prevTotals.cpl,          true],
    cac:      [totals.cac,          prevTotals && prevTotals.cac,          true],
    roas:     [totals.roas,         prevTotals && prevTotals.roas,         false],
    roi:      [totals.roi,          prevTotals && prevTotals.roi,          false],
    pipeline: [dr.pipelineValue,    pd.pipelineValue,                      false],
    revenue:  [dr.closedRevenue,    pd.closedRevenue,                      false],
  };

  for (const key of Object.keys(cmpMap)) {
    const cmpEl = el(`cmp-${key}`);
    if (!cmpEl) continue;
    const [cur, prv, lib] = cmpMap[key];
    if (showCmp) {
      cmpEl.innerHTML = compareBadgeHTML(cur, prv, lib);
      cmpEl.classList.remove('hidden');
    } else {
      cmpEl.classList.add('hidden');
    }
  }
}

// ─── Chart colours ────────────────────────────────────────────────────────────
const C = {
  google: '#4285f4', bing: '#00a4ef', leads: '#34d399',
  revenue: '#f59e0b', grid: '#232323', text: '#888888',
};

const BASE_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#181c27', borderColor: '#21263a', borderWidth: 1,
      titleColor: '#e6e8f0', bodyColor: '#7b859e', padding: 10,
    },
  },
  scales: {
    x: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 10 } } },
    y: {
      grid: { color: C.grid },
      ticks: { color: C.text, font: { size: 10 }, callback: v => v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v },
    },
  },
};

function destroyChart(key) {
  if (CHARTS[key]) { CHARTS[key].destroy(); CHARTS[key] = null; }
}

function weekLabel(d) {
  return new Date(d).toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
}

function renderChartWeekly(weekly) {
  destroyChart('weekly');
  const canvas = el('chartWeekly');
  if (!canvas || !weekly || !weekly.length) return;

  CHARTS.weekly = new Chart(canvas, {
    data: {
      labels: weekly.map(d => weekLabel(d.weekStart || d.date)),
      datasets: [
        {
          type: 'bar', label: 'Google', stack: 'spend', order: 2,
          data: weekly.map(d => +(d.googleSpend || 0).toFixed(2)),
          backgroundColor: C.google + 'cc',
        },
        {
          type: 'bar', label: 'Microsoft', stack: 'spend', order: 2,
          data: weekly.map(d => +(d.bingSpend || 0).toFixed(2)),
          backgroundColor: C.bing + 'cc',
        },
        {
          type: 'line', label: 'Leads', yAxisID: 'yLeads', order: 1,
          data: weekly.map(d => +(d.leads || 0).toFixed(1)),
          borderColor: C.leads, backgroundColor: C.leads + '22',
          pointRadius: 4, tension: 0.3, fill: false,
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        x: BASE_OPTS.scales.x,
        y: { ...BASE_OPTS.scales.y, stacked: true },
        yLeads: {
          position: 'right', grid: { drawOnChartArea: false },
          ticks: { color: C.leads, font: { size: 10 }, callback: v => Math.round(v) },
        },
      },
      plugins: {
        ...BASE_OPTS.plugins,
        tooltip: {
          ...BASE_OPTS.plugins.tooltip,
          callbacks: {
            label: ctx => ctx.datasetIndex < 2
              ? ctx.dataset.label + ': $' + ctx.raw.toLocaleString('en-AU')
              : 'Leads: ' + ctx.raw,
          },
        },
      },
    },
  });
}

function renderChartDaily(daily) {
  destroyChart('daily');
  const canvas = el('chartDaily');
  if (!canvas || !daily || !daily.length) return;

  CHARTS.daily = new Chart(canvas, {
    type: 'line',
    data: {
      labels: daily.map(d => weekLabel(d.date)),
      datasets: [{
        label: 'Leads',
        data: daily.map(d => +(d.leads || 0).toFixed(1)),
        borderColor: C.leads, backgroundColor: C.leads + '18',
        fill: true, tension: 0.3, pointRadius: 2,
      }],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        x: BASE_OPTS.scales.x,
        y: { ...BASE_OPTS.scales.y, ticks: { color: C.text, font: { size: 10 }, callback: v => Math.round(v) } },
      },
    },
  });
}

function renderChartCPL(campaigns) {
  destroyChart('cpl');
  const canvas = el('chartCPL');
  if (!canvas) return;

  const sorted = campaigns
    .filter(c => c.cpl > 0 && c.leads > 0)
    .sort((a, b) => b.cpl - a.cpl)
    .slice(0, 10);

  if (!sorted.length) return;

  CHARTS.cpl = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: sorted.map(c => c.name.length > 28 ? c.name.slice(0, 26) + '…' : c.name),
      datasets: [{
        label: 'CPL',
        data: sorted.map(c => +c.cpl.toFixed(2)),
        backgroundColor: sorted.map(c => (c.source === 'google' ? C.google : C.bing) + 'cc'),
      }],
    },
    options: {
      ...BASE_OPTS,
      indexAxis: 'y',
      scales: {
        x: { ...BASE_OPTS.scales.x, ticks: { color: C.text, font: { size: 10 }, callback: v => '$' + v } },
        y: { grid: { color: C.grid }, ticks: { color: C.text, font: { size: 10 } } },
      },
    },
  });
}

function renderChartSpendShare(campaigns) {
  destroyChart('spendShare');
  const canvas = el('chartSpendShare');
  if (!canvas) return;

  const gs = campaigns.filter(c => c.source === 'google').reduce((s, c) => s + (c.spend || 0), 0);
  const bs = campaigns.filter(c => c.source === 'bing').reduce((s, c) => s + (c.spend || 0), 0);
  if (gs + bs === 0) return;

  CHARTS.spendShare = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Google Ads', 'Microsoft Ads'],
      datasets: [{
        data: [+gs.toFixed(2), +bs.toFixed(2)],
        backgroundColor: [C.google + 'cc', C.bing + 'cc'],
        borderColor: [C.google, C.bing],
        borderWidth: 1, hoverOffset: 6,
      }],
    },
    options: {
      ...BASE_OPTS,
      cutout: '65%',
      plugins: {
        ...BASE_OPTS.plugins,
        legend: {
          display: true, position: 'bottom',
          labels: { color: C.text, boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          ...BASE_OPTS.plugins.tooltip,
          callbacks: {
            label: ctx => ' $' + ctx.raw.toLocaleString('en-AU') + ' (' + ((ctx.raw / (gs + bs)) * 100).toFixed(0) + '%)',
          },
        },
      },
    },
  });
}

function renderChartSpendRevenue(campaigns) {
  destroyChart('spendRevenue');
  const canvas = el('chartSpendRevenue');
  if (!canvas) return;

  const gSpend = campaigns.filter(c => c.source === 'google').reduce((s, c) => s + (c.spend || 0), 0);
  const bSpend = campaigns.filter(c => c.source === 'bing').reduce((s, c) => s + (c.spend || 0), 0);
  const gRev   = campaigns.filter(c => c.source === 'google').reduce((s, c) => s + (c.closedRevenue || 0), 0);
  const bRev   = campaigns.filter(c => c.source === 'bing').reduce((s, c) => s + (c.closedRevenue || 0), 0);

  CHARTS.spendRevenue = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['Google', 'Microsoft'],
      datasets: [
        {
          label: 'Spend',
          data: [+gSpend.toFixed(2), +bSpend.toFixed(2)],
          backgroundColor: [C.google + 'cc', C.bing + 'cc'],
          borderColor: [C.google, C.bing], borderWidth: 1,
        },
        {
          label: 'Revenue',
          data: [+gRev.toFixed(2), +bRev.toFixed(2)],
          backgroundColor: [C.revenue + 'cc', C.revenue + '66'],
          borderColor: [C.revenue, C.revenue + 'aa'], borderWidth: 1,
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      plugins: {
        ...BASE_OPTS.plugins,
        legend: {
          display: true, position: 'bottom',
          labels: { color: C.text, boxWidth: 12, font: { size: 11 } },
        },
      },
    },
  });
}

// ─── Table ────────────────────────────────────────────────────────────────────
function renderTable(campaigns) {
  const tbody  = el('tBody');
  const footer = el('tableFooter');
  if (!tbody) return;

  const sorted = campaigns.slice().sort((a, b) => {
    let av = a[S.sortCol], bv = b[S.sortCol];
    if (typeof av === 'string') return S.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    av = av || 0; bv = bv || 0;
    return S.sortDir === 'asc' ? av - bv : bv - av;
  });

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="15" class="empty">No campaigns match current filters.</td></tr>';
    if (footer) footer.textContent = '';
    updateSortHeaders();
    return;
  }

  tbody.innerHTML = sorted.map(c => {
    const geo    = c.geo || detectGeo(c.name) || '';
    const srcCls = c.source === 'google' ? 'google' : 'bing';
    const srcLbl = c.source === 'google' ? 'Google' : 'Bing';
    // ctr, closeRate, roi come from API already as percentages (e.g. 6.1, 56.9, 5848)
    const roiCls = (c.roi || 0) > 0 ? 'pos' : (c.roi || 0) < -5 ? 'neg' : 'neu';
    const pctDirect = function(v) { return v != null ? v.toFixed(1) + '%' : '—'; };
    return '<tr>'
      + '<td>' + c.name + (geo ? '<span class="geo-tag">' + geo + '</span>' : '') + '</td>'
      + '<td><span class="src-pill ' + srcCls + '">' + srcLbl + '</span></td>'
      + '<td class="n">' + fmtMoney(c.spend) + '</td>'
      + '<td class="n">' + fmtNum(c.clicks) + '</td>'
      + '<td class="n">' + fmtNum(c.impressions) + '</td>'
      + '<td class="n">' + pctDirect(c.ctr) + '</td>'
      + '<td class="n">' + fmtNum(c.leads) + '</td>'
      + '<td class="n">' + fmtNum(c.closedWonDeals) + '</td>'
      + '<td class="n">' + pctDirect(c.closeRate) + '</td>'
      + '<td class="n">' + fmtMoney(c.cpl) + '</td>'
      + '<td class="n">' + fmtMoney(c.cac) + '</td>'
      + '<td class="n">' + fmtMoney(c.pipelineValue) + '</td>'
      + '<td class="n">' + fmtMoney(c.closedRevenue) + '</td>'
      + '<td class="n">' + fmtX(c.roas) + '</td>'
      + '<td class="n ' + roiCls + '">' + (c.roi != null ? c.roi.toFixed(0) + '%' : '—') + '</td>'
      + '</tr>';
  }).join('');

  if (footer) footer.textContent = sorted.length + ' campaign' + (sorted.length !== 1 ? 's' : '');
  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll('thead th.s').forEach(th => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.col === S.sortCol) th.classList.add(S.sortDir);
  });
}

// ─── Pills ────────────────────────────────────────────────────────────────────
function renderPills() {
  const bar   = el('pillsBar');
  const inner = el('filterPills');
  const badge = el('filterBadge');
  if (!inner) return;

  const pills = [];

  if (S.country !== 'all') {
    pills.push({
      label: 'Country: ' + S.country,
      remove: function() { S.country = 'all'; syncCountryBtns(); applyAndRender(); },
    });
  }
  if (S.channel !== 'all') {
    pills.push({
      label: 'Channel: ' + (S.channel === 'google' ? 'Google Ads' : 'Microsoft Ads'),
      remove: function() { S.channel = 'all'; syncChannelBtns(); populateCampaignDropdown(); applyAndRender(); },
    });
  }
  if (S.campaign !== 'all') {
    const found = (S.data && S.data.campaigns || []).find(function(c) { return c.id === S.campaign || c.name === S.campaign; });
    pills.push({
      label: 'Campaign: ' + (found ? found.name : S.campaign),
      remove: function() { S.campaign = 'all'; var sel = el('campaignSelect'); if (sel) sel.value = 'all'; applyAndRender(); },
    });
  }

  if (badge) {
    badge.textContent = pills.length;
    pills.length > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden');
  }

  if (!pills.length) {
    bar && bar.classList.add('hidden');
    return;
  }

  bar && bar.classList.remove('hidden');
  inner.innerHTML = pills.map(function(p, i) {
    return '<span class="pill-tag">' + p.label + '<button class="pill-x" data-pill="' + i + '">✕</button></span>';
  }).join('') + '<button class="clear-all" id="clearAllPills">Clear all</button>';

  var removeFns = pills.map(function(p) { return p.remove; });
  inner.querySelectorAll('.pill-x').forEach(function(btn) {
    btn.addEventListener('click', function() { removeFns[+btn.dataset.pill](); });
  });
  var clearBtn = el('clearAllPills');
  if (clearBtn) clearBtn.addEventListener('click', clearAllFilters);
}

function clearAllFilters() {
  S.country = 'all'; S.channel = 'all'; S.campaign = 'all';
  syncCountryBtns(); syncChannelBtns();
  var sel = el('campaignSelect');
  if (sel) sel.value = 'all';
  applyAndRender();
}

// ─── Dynamic controls ─────────────────────────────────────────────────────────
function syncCountryBtns() {
  document.querySelectorAll('#countryBtns .ftab').forEach(function(b) {
    b.classList.toggle('active', b.dataset.country === S.country);
  });
}

function syncChannelBtns() {
  document.querySelectorAll('#channelBtns .ftab').forEach(function(b) {
    b.classList.toggle('active', b.dataset.channel === S.channel);
  });
}

function populateCountryBtns(campaigns) {
  var geos  = new Set((campaigns || []).map(function(c) { return c.geo || detectGeo(c.name); }).filter(Boolean));
  var group = el('countryGroup');
  var btns  = el('countryBtns');
  if (!btns || !group) return;

  if (!geos.size) { group.style.display = 'none'; return; }
  group.style.display = '';

  btns.innerHTML = '<button class="ftab ' + (S.country === 'all' ? 'active' : '') + '" data-country="all">All</button>'
    + ['AU', 'NZ', 'UK'].filter(function(g) { return geos.has(g); }).map(function(g) {
      return '<button class="ftab ' + (S.country === g ? 'active' : '') + '" data-country="' + g + '">' + g + '</button>';
    }).join('');

  btns.querySelectorAll('.ftab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      S.country = btn.dataset.country;
      syncCountryBtns();
      populateCampaignDropdown();
      applyAndRender();
    });
  });
}

function populateCampaignDropdown() {
  var sel = el('campaignSelect');
  if (!sel || !S.data) return;

  var campaigns = S.data.campaigns || [];
  if (S.channel !== 'all') {
    var src = S.channel === 'google' ? 'google' : 'bing';
    campaigns = campaigns.filter(function(c) { return c.source === src; });
  }
  if (S.country !== 'all') {
    campaigns = campaigns.filter(function(c) { return (c.geo || detectGeo(c.name)) === S.country; });
  }

  sel.innerHTML = '<option value="all">All campaigns</option>'
    + campaigns.map(function(c) {
      var val = c.id || c.name;
      var selected = (c.id === S.campaign || c.name === S.campaign) ? ' selected' : '';
      return '<option value="' + val + '"' + selected + '>' + c.name + '</option>';
    }).join('');

  var valid = campaigns.some(function(c) { return c.id === S.campaign || c.name === S.campaign; });
  if (!valid && S.campaign !== 'all') {
    S.campaign = 'all';
    sel.value = 'all';
  }
}

// ─── Status badges ────────────────────────────────────────────────────────────
function updateStatusBadges(data) {
  function hasErr(src) {
    return data.errors.some(function(e) { return e.source === src || e.source === src + '_daily'; });
  }
  function set(id, cfg, err) {
    var b = el(id);
    if (!b) return;
    b.className = 'badge ' + (!cfg ? 'off' : err ? 'err' : 'ok');
  }
  set('badgeGoogle',  data.sources.google.configured,  hasErr('google'));
  set('badgeBing',    data.sources.bing.configured,    hasErr('bing'));
  set('badgeHubspot', data.sources.hubspot.configured, hasErr('hubspot_leads') || hasErr('hubspot_revenue'));
}

function updateLastRefreshed(ts) {
  var e = el('lastRefreshed');
  if (!e) return;
  try {
    e.textContent = 'Updated ' + new Date(ts).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  } catch (err) { e.textContent = ''; }
}

function showErrors(errors) {
  var banner = el('errorBanner');
  if (!banner) return;
  if (!errors || !errors.length) { banner.classList.add('hidden'); return; }
  banner.innerHTML = errors.map(function(e) { return '⚠ ' + e.source + ': ' + e.message; }).join('<br>');
  banner.classList.remove('hidden');
}

// ─── Main render pipeline ─────────────────────────────────────────────────────
function applyAndRender() {
  if (!S.data) return;

  var all      = S.data.campaigns || [];
  var filtered = applyFilters(all);
  var totals   = recalcTotals(filtered);

  var prevFiltered = S.prevData ? applyFilters(S.prevData.campaigns || []) : null;
  var prevTotals   = prevFiltered ? recalcTotals(prevFiltered) : null;

  var fts = getFilteredTimeSeries(S.data.timeSeries, filtered, all);

  renderKPIs(totals, prevTotals, S.data.dealRevenue, S.prevData && S.prevData.dealRevenue);
  renderChartWeekly(fts.weekly);
  renderChartDaily(fts.daily);
  renderChartCPL(filtered);
  renderChartSpendShare(filtered);
  renderChartSpendRevenue(filtered);
  renderTable(filtered);
  renderPills();

  var mpl = el('mobilePeriodLabel');
  if (mpl) mpl.textContent = getPeriodLabel();
}

// ─── Load ─────────────────────────────────────────────────────────────────────
async function load(forceRefresh) {
  if (S.loading) return;
  S.loading = true;

  var overlay    = el('loadingOverlay');
  var btnRefresh = el('btnRefresh');
  if (overlay)    overlay.classList.remove('hidden');
  if (btnRefresh) btnRefresh.classList.add('spinning');

  try {
    var range = getDateRange();
    var data  = await fetchData(range.start, range.end, !!forceRefresh);
    S.data = data;

    populateCountryBtns(data.campaigns);
    populateCampaignDropdown();
    updateStatusBadges(data);
    updateLastRefreshed(data.refreshedAt);
    showErrors(data.errors);

    if (S.compare) {
      var prev = getPrevDateRange(range.start, range.end);
      try { S.prevData = await fetchData(prev.start, prev.end); }
      catch (e) { S.prevData = null; }
    } else {
      S.prevData = null;
    }

    applyAndRender();
  } catch (err) {
    console.error('Load error:', err);
    var banner = el('errorBanner');
    if (banner) {
      banner.textContent = 'Failed to load analytics data: ' + err.message;
      banner.classList.remove('hidden');
    }
  } finally {
    S.loading = false;
    if (overlay)    overlay.classList.add('hidden');
    if (btnRefresh) btnRefresh.classList.remove('spinning');
  }
}

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCSV() {
  if (!S.data) return;
  var filtered = applyFilters(S.data.campaigns || []);
  var range    = getDateRange();

  var hdr = ['Campaign','Source','Geo','Spend','Clicks','Impressions','CTR',
    'Leads','Won','Close%','CPL','CAC','Pipeline','Revenue','ROAS','ROI'];

  var rows = filtered.map(function(c) {
    return [
      '"' + (c.name || '').replace(/"/g, '""') + '"',
      c.source || '',
      c.geo || detectGeo(c.name) || '',
      (c.spend || 0).toFixed(2),
      c.clicks || 0,
      c.impressions || 0,
      ((c.ctr || 0) * 100).toFixed(2) + '%',
      (c.leads || 0).toFixed(1),
      c.closedWonDeals || 0,
      ((c.closeRate || 0) * 100).toFixed(1) + '%',
      (c.cpl || 0).toFixed(2),
      (c.cac || 0).toFixed(2),
      (c.pipelineValue || 0).toFixed(2),
      (c.closedRevenue || 0).toFixed(2),
      (c.roas || 0).toFixed(2),
      ((c.roi || 0) * 100).toFixed(1) + '%',
    ].join(',');
  });

  var csv  = [hdr.join(',')].concat(rows).join('\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = 'duress-growth-' + range.start + '-to-' + range.end + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Event listeners ──────────────────────────────────────────────────────────
function initListeners() {
  var periodTabs = el('periodTabs');
  if (periodTabs) {
    periodTabs.addEventListener('click', function(e) {
      var btn = e.target.closest('.ftab');
      if (!btn) return;
      S.dateRange = btn.dataset.range;
      periodTabs.querySelectorAll('.ftab').forEach(function(b) { b.classList.toggle('active', b === btn); });
      var cd = el('customDates');
      if (cd) cd.classList.toggle('hidden', S.dateRange !== 'custom');
      if (S.dateRange !== 'custom') load();
    });
  }

  var customStart = el('customStart');
  if (customStart) customStart.addEventListener('change', function(e) {
    S.customStart = e.target.value;
    if (S.customEnd) load();
  });

  var customEnd = el('customEnd');
  if (customEnd) customEnd.addEventListener('change', function(e) {
    S.customEnd = e.target.value;
    if (S.customStart) load();
  });

  var channelBtns = el('channelBtns');
  if (channelBtns) {
    channelBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('.ftab');
      if (!btn) return;
      S.channel = btn.dataset.channel;
      syncChannelBtns();
      populateCampaignDropdown();
      applyAndRender();
    });
  }

  var campaignSel = el('campaignSelect');
  if (campaignSel) campaignSel.addEventListener('change', function(e) {
    S.campaign = e.target.value;
    applyAndRender();
  });

  var compareToggle = el('compareToggle');
  if (compareToggle) compareToggle.addEventListener('change', function(e) {
    S.compare = e.target.checked;
    load();
  });

  var btnRefresh = el('btnRefresh');
  if (btnRefresh) btnRefresh.addEventListener('click', function() { load(true); });

  var btnExport = el('btnExport');
  if (btnExport) btnExport.addEventListener('click', exportCSV);

  document.querySelectorAll('thead th.s').forEach(function(th) {
    th.addEventListener('click', function() {
      var col = th.dataset.col;
      if (S.sortCol === col) {
        S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        S.sortCol = col;
        S.sortDir = (col === 'name' || col === 'source') ? 'asc' : 'desc';
      }
      if (S.data) renderTable(applyFilters(S.data.campaigns || []));
    });
  });

  var tableSearch = el('tableSearch');
  if (tableSearch) tableSearch.addEventListener('input', function(e) {
    S.searchTerm = e.target.value;
    if (S.data) renderTable(applyFilters(S.data.campaigns || []));
  });

  var btnMobile = el('btnMobileFilters');
  if (btnMobile) btnMobile.addEventListener('click', function() {
    var panel = el('filterPanel');
    if (panel) panel.classList.toggle('open');
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  initListeners();
  load();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
