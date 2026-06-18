const { calculate } = require('./metrics');
const logger = require('./logger');

// ─── Source classification ────────────────────────────────────────────────────
const UTM_SOURCE_MAP = {
  google:       'google',
  'google ads': 'google',
  googleads:    'google',
  adwords:      'google',
  microsoft:    'bing',
  bing:         'bing',
  bingads:      'bing',
  'bing ads':   'bing',
};

// HubSpot's hs_analytics_source enum → canonical key.
// 'paid_search' is an intermediate key distributed across platforms in mergeCampaigns.
const HS_SOURCE_MAP = {
  PAID_SEARCH:     'paid_search',
  ORGANIC_SEARCH:  'organic',
  DIRECT_TRAFFIC:  'direct',
  SOCIAL_MEDIA:    'direct',
  EMAIL_MARKETING: 'direct',
  REFERRALS:       'direct',
  OTHER_CAMPAIGNS: 'direct',
  OFFLINE:         'direct',
};

function classifySource(props) {
  const utm = (props.utm_source || '').toLowerCase().trim();
  if (utm) return UTM_SOURCE_MAP[utm] || utm;
  return HS_SOURCE_MAP[(props.hs_analytics_source || '').toUpperCase().trim()] || 'direct';
}

// ─── Lead grouping ────────────────────────────────────────────────────────────
/**
 * Build a map of source → lead count from HubSpot contact objects.
 * Also returns daily lead counts for time-series: { 'YYYY-MM-DD': count }
 */
function groupLeads(contacts) {
  const bySource = {};  // source → count
  const byDate   = {};  // 'YYYY-MM-DD' → count

  for (const c of contacts) {
    const props  = c.properties || {};
    const source = classifySource(props);
    bySource[source] = (bySource[source] || 0) + 1;

    const day = (props.createdate || '').slice(0, 10);
    if (day) byDate[day] = (byDate[day] || 0) + 1;
  }

  logger.info('Lead grouping by source', bySource);
  return { bySource, byDate };
}

// ─── Time-series helpers ──────────────────────────────────────────────────────
/**
 * Build daily time-series merging ad spend (Google+Bing daily rows) with HubSpot daily leads.
 */
function buildTimeSeries(googleDaily, bingDaily, hubspotDailyLeads, hubspotDailyRevenue) {
  const dateMap = {};

  const ensure = (d) => {
    if (!dateMap[d]) dateMap[d] = { date: d, googleSpend: 0, bingSpend: 0, spend: 0, leads: 0, revenue: 0 };
    return dateMap[d];
  };

  for (const r of googleDaily) { const e = ensure(r.date); e.googleSpend += r.spend; e.spend += r.spend; }
  for (const r of bingDaily)   { const e = ensure(r.date); e.bingSpend   += r.spend; e.spend += r.spend; }

  for (const [date, count]   of Object.entries(hubspotDailyLeads))   { ensure(date).leads   += count; }
  for (const [date, revenue] of Object.entries(hubspotDailyRevenue)) { ensure(date).revenue += revenue; }

  const daily  = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  const weekly = rollupToWeeks(daily);

  return { daily, weekly };
}

function rollupToWeeks(daily) {
  const weeks = {};
  for (const d of daily) {
    const dt   = new Date(d.date + 'T00:00:00Z');
    const dow  = dt.getUTCDay();
    const monday = new Date(dt);
    monday.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7));
    const weekKey = monday.toISOString().slice(0, 10);
    if (!weeks[weekKey]) weeks[weekKey] = { weekStart: weekKey, googleSpend: 0, bingSpend: 0, spend: 0, leads: 0, revenue: 0 };
    const w = weeks[weekKey];
    w.googleSpend += d.googleSpend;
    w.bingSpend   += d.bingSpend;
    w.spend       += d.spend;
    w.leads       += d.leads;
    w.revenue     += d.revenue;
  }
  return Object.values(weeks).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ─── Main merge ───────────────────────────────────────────────────────────────
/**
 * Merge ad campaigns with HubSpot leads and deal revenue.
 *
 * Strategy:
 *   - HubSpot leads are grouped by utm_source (google / bing).
 *   - Within each source, leads are allocated proportionally by campaign spend.
 *     (e.g. GS AU = 73% of Google spend → gets 73% of Google leads)
 *   - Revenue (pipeline value + closed) is split proportionally by source spend.
 *
 * @param {Array}  adCampaigns      - From Google Ads + Microsoft Ads services
 * @param {Array}  hubspotContacts  - From hubspot.getLeads()
 * @param {object} dealRevenue      - From hubspot.getDealRevenue()
 * @returns {Array} Campaign rows with all metrics
 */
function mergeCampaigns(adCampaigns, hubspotContacts, dealRevenue) {
  const { bySource: leadsBySource } = groupLeads(hubspotContacts);

  // Group ad campaigns by source
  const adBySource = {};
  for (const c of adCampaigns) {
    const src = c.source; // already 'google' or 'bing' from the service
    if (!adBySource[src]) adBySource[src] = [];
    adBySource[src].push(c);
  }

  // Total spend per source (for revenue allocation)
  const spendBySource = {};
  for (const [src, camps] of Object.entries(adBySource)) {
    spendBySource[src] = camps.reduce((s, c) => s + c.spend, 0);
  }
  const totalSpend = Object.values(spendBySource).reduce((s, v) => s + v, 0);

  // Distribute contacts tagged PAID_SEARCH (no utm_source) proportionally by platform spend.
  const paidSearchLeads = leadsBySource['paid_search'] || 0;
  if (paidSearchLeads > 0 && totalSpend > 0) {
    for (const src of Object.keys(adBySource)) {
      const frac = (spendBySource[src] || 0) / totalSpend;
      leadsBySource[src] = (leadsBySource[src] || 0) + Math.round(paidSearchLeads * frac);
    }
    delete leadsBySource['paid_search'];
  }

  const totalLeads = Object.values(leadsBySource).reduce((s, c) => s + c, 0);

  const rows = [];

  for (const [src, campaigns] of Object.entries(adBySource)) {
    const srcLeads   = leadsBySource[src] || 0;
    const srcSpend   = spendBySource[src] || 0;
    const srcRevFrac = totalSpend > 0 ? srcSpend / totalSpend : 0;

    // Revenue attributed to this source proportionally by spend
    const srcPipelineValue = (dealRevenue.pipelineValue || 0) * srcRevFrac;
    const srcClosedRevenue = (dealRevenue.closedRevenue || 0) * srcRevFrac;
    const srcWonDeals      = Math.round((dealRevenue.wonDealCount || 0) * srcRevFrac);

    const totalSrcSpend = campaigns.reduce((s, c) => s + c.spend, 0);

    for (const campaign of campaigns) {
      const spendRatio = totalSrcSpend > 0 ? campaign.spend / totalSrcSpend : 1 / campaigns.length;
      const leads        = Math.round(srcLeads * spendRatio);
      const wonDeals     = Math.max(0, Math.round(srcWonDeals * spendRatio));
      const pipelineValue = srcPipelineValue * spendRatio;
      const closedRevenue = srcClosedRevenue * spendRatio;

      const metrics = calculate(
        { spend: campaign.spend, clicks: campaign.clicks, impressions: campaign.impressions, conversions: campaign.conversions },
        { leads, closedWonDeals: wonDeals, pipelineValue, closedRevenue }
      );

      rows.push({
        id:     campaign.id,
        name:   campaign.name,
        source: src,
        geo:    extractGeo(campaign.name),
        ...metrics,
      });
    }
  }

  rows.sort((a, b) => (b.spend || 0) - (a.spend || 0));

  // Totals row
  const totals = buildTotals(rows, totalLeads, dealRevenue);

  // Expose the full source breakdown for the board dashboard
  const sourceBreakdown = {
    google:  leadsBySource['google']  || 0,
    bing:    leadsBySource['bing']    || 0,
    organic: leadsBySource['organic'] || 0,
    direct:  leadsBySource['direct']  || 0,
  };

  return { campaigns: rows, totals, sourceBreakdown };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractGeo(name) {
  const m = (name || '').match(/\b(AU|NZ|UK|US|CA|SG|IE)\b/i);
  return m ? m[1].toUpperCase() : null;
}

function buildTotals(rows, totalLeads, dealRevenue) {
  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  return calculate(
    {
      spend:       totalSpend,
      clicks:      rows.reduce((s, r) => s + (r.clicks || 0), 0),
      impressions: rows.reduce((s, r) => s + (r.impressions || 0), 0),
      conversions: rows.reduce((s, r) => s + (r.conversions || 0), 0),
    },
    {
      leads:          totalLeads,
      closedWonDeals: dealRevenue.wonDealCount   || 0,
      pipelineValue:  dealRevenue.pipelineValue  || 0,
      closedRevenue:  dealRevenue.closedRevenue  || 0,
    }
  );
}

module.exports = { mergeCampaigns, groupLeads, buildTimeSeries, normaliseSource };
