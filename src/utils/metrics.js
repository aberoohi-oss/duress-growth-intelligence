function safe(numerator, denominator, decimals = 2) {
  if (!denominator || denominator === 0) return null;
  return parseFloat((numerator / denominator).toFixed(decimals));
}

function pct(value, decimals = 1) {
  if (value === null || value === undefined) return null;
  return parseFloat((value * 100).toFixed(decimals));
}

/**
 * Calculate all derived metrics for a campaign given raw ad data and attribution data.
 *
 * @param {object} ad - { spend, clicks, impressions, conversions }
 * @param {object} attr - { leads, closedWonDeals, pipelineValue, closedRevenue }
 * @returns {object} All calculated metrics
 */
function calculate(ad, attr) {
  const spend = ad.spend || 0;
  const clicks = ad.clicks || 0;
  const impressions = ad.impressions || 0;
  const conversions = ad.conversions || 0;

  const leads = attr.leads || 0;
  const closedWonDeals = attr.closedWonDeals || 0;
  const pipelineValue = attr.pipelineValue || 0;
  const closedRevenue = attr.closedRevenue || 0;

  return {
    spend,
    clicks,
    impressions,
    conversions,
    leads,
    closedWonDeals,
    pipelineValue,
    closedRevenue,

    ctr: pct(safe(clicks, impressions, 4)),
    conversionRate: pct(safe(conversions, clicks, 4)),
    cpc: safe(spend, clicks),
    cpm: safe(spend * 1000, impressions),
    cpl: safe(spend, leads),
    cac: safe(spend, closedWonDeals),
    roas: safe(closedRevenue, spend),
    roi: spend > 0 ? parseFloat((((closedRevenue - spend) / spend) * 100).toFixed(1)) : null,
    closeRate: pct(safe(closedWonDeals, leads, 4)),
    avgDealValue: safe(closedRevenue, closedWonDeals),
  };
}

/**
 * Roll up an array of campaign metric objects into a single totals object.
 */
function rollup(campaigns) {
  const totals = campaigns.reduce(
    (acc, c) => {
      acc.spend += c.spend || 0;
      acc.clicks += c.clicks || 0;
      acc.impressions += c.impressions || 0;
      acc.conversions += c.conversions || 0;
      acc.leads += c.leads || 0;
      acc.closedWonDeals += c.closedWonDeals || 0;
      acc.pipelineValue += c.pipelineValue || 0;
      acc.closedRevenue += c.closedRevenue || 0;
      return acc;
    },
    {
      spend: 0,
      clicks: 0,
      impressions: 0,
      conversions: 0,
      leads: 0,
      closedWonDeals: 0,
      pipelineValue: 0,
      closedRevenue: 0,
    }
  );

  return {
    ...totals,
    ...calculate(totals, totals),
  };
}

module.exports = { calculate, rollup };
