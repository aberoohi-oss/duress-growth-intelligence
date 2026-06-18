const express = require('express');
const router  = express.Router();

const googleAds    = require('../services/googleAds');
const microsoftAds = require('../services/microsoftAds');
const hubspot      = require('../services/hubspot');
const { mergeCampaigns, buildTimeSeries, groupLeads } = require('../utils/attribution');
const dateRanges   = require('../utils/dateRanges');
const cache        = require('../utils/cache');
const logger       = require('../utils/logger');

// ─── Core data fetch ──────────────────────────────────────────────────────────
async function fetchAll(start, end) {
  const [googleSummary, googleDaily, bingSummary, bingDaily, leads, revenue] =
    await Promise.allSettled([
      googleAds.getCampaigns(start, end),
      googleAds.getDailyData(start, end),
      microsoftAds.getCampaigns(start, end),
      microsoftAds.getDailyData(start, end),
      hubspot.getLeads(start, end),
      hubspot.getDealRevenue(start, end),
    ]);

  const errors = [];
  const ok = (r, fallback, source) => {
    if (r.status === 'fulfilled') return r.value;
    errors.push({ source, message: r.reason?.message });
    return fallback;
  };

  return {
    googleCampaigns: ok(googleSummary, [],  'google'),
    googleDaily:     ok(googleDaily,   [],  'google_daily'),
    bingCampaigns:   ok(bingSummary,   [],  'bing'),
    bingDaily:       ok(bingDaily,     [],  'bing_daily'),
    hubspotLeads:    ok(leads,         [],  'hubspot_leads'),
    dealRevenue:     ok(revenue, { pipelineValue: 0, closedRevenue: 0, wonDealCount: 0, openDealCount: 0, dailyRevenue: {} }, 'hubspot_revenue'),
    errors,
  };
}

// ─── GET /api/analytics ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { dateRange, startDate, endDate, refresh } = req.query;
    const range    = dateRanges.resolve(dateRange, startDate, endDate);
    const cacheKey = cache.buildKey('analytics_v2', { start: range.start, end: range.end });

    if (refresh !== 'true') {
      const hit = cache.get(cacheKey);
      if (hit) return res.json({ ...hit, fromCache: true });
    }

    logger.info('Fetching fresh analytics', range);
    const data = await fetchAll(range.start, range.end);

    const allAdCampaigns = [...data.googleCampaigns, ...data.bingCampaigns];
    const { campaigns, totals, sourceBreakdown } = mergeCampaigns(allAdCampaigns, data.hubspotLeads, data.dealRevenue);

    const { byDate: dailyLeads } = groupLeads(data.hubspotLeads);
    const timeSeries = buildTimeSeries(
      data.googleDaily,
      data.bingDaily,
      dailyLeads,
      data.dealRevenue.dailyRevenue
    );

    const payload = {
      dateRange:   range,
      refreshedAt: new Date().toISOString(),
      sources: {
        google:  { configured: googleAds.isConfigured(),    campaigns: data.googleCampaigns.length },
        bing:    { configured: microsoftAds.isConfigured(), campaigns: data.bingCampaigns.length },
        hubspot: { configured: hubspot.isConfigured(),      leads: data.hubspotLeads.length, deals: data.dealRevenue.wonDealCount },
      },
      errors:    data.errors,
      totals,
      campaigns,
      sourceBreakdown,
      timeSeries,
      dealRevenue: {
        openDealCount:  data.dealRevenue.openDealCount,
        wonDealCount:   data.dealRevenue.wonDealCount,
        pipelineValue:  data.dealRevenue.pipelineValue,
        closedRevenue:  data.dealRevenue.closedRevenue,
      },
    };

    cache.set(cacheKey, payload);
    res.json({ ...payload, fromCache: false });
  } catch (err) {
    logger.error('Analytics route error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to fetch analytics data', message: err.message });
  }
});

// POST /api/analytics/refresh
router.post('/refresh', (req, res) => {
  cache.flush();
  logger.info('Cache flushed by manual refresh');
  res.json({ ok: true, message: 'Cache cleared.' });
});

// GET /api/analytics/status
router.get('/status', (req, res) => {
  res.json({
    google:     googleAds.isConfigured(),
    bing:       microsoftAds.isConfigured(),
    hubspot:    hubspot.isConfigured(),
    cacheStats: cache.stats(),
  });
});

module.exports = router;
