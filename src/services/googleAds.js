const { GoogleAdsApi } = require('google-ads-api');
const logger = require('../utils/logger');

let client = null;
function getClient() {
  if (!client) {
    client = new GoogleAdsApi({
      client_id:        process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret:    process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token:  process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });
  }
  return client;
}

function isConfigured() {
  return !!(
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID
  );
}

function getCustomer() {
  const opts = {
    customer_id:   process.env.GOOGLE_ADS_CUSTOMER_ID,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    opts.login_customer_id = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }
  return getClient().Customer(opts);
}

/**
 * Summary campaign metrics for the date range.
 */
async function getCampaigns(startDate, endDate) {
  if (!isConfigured()) { logger.warn('Google Ads not configured — skipping'); return []; }
  logger.info('Fetching Google Ads campaigns', { startDate, endDate });

  try {
    const rows = await getCustomer().query(`
      SELECT
        campaign.id, campaign.name,
        metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
        AND campaign.status != 'REMOVED'
        AND metrics.cost_micros > 0
      ORDER BY metrics.cost_micros DESC
    `);

    const campaigns = rows.map(r => ({
      id:          `google_${r.campaign.id}`,
      name:        r.campaign.name,
      source:      'google',
      spend:       (r.metrics.cost_micros || 0) / 1_000_000,
      clicks:      r.metrics.clicks || 0,
      impressions: r.metrics.impressions || 0,
      conversions: r.metrics.conversions || 0,
    }));

    logger.info(`Google Ads: ${campaigns.length} campaigns`);
    return campaigns;
  } catch (err) {
    logger.error('Google Ads error', { error: err.message });
    throw new Error(`Google Ads error: ${err.message}`);
  }
}

/**
 * Daily spend + conversions per campaign — used for time-series charts.
 * Returns: [{ date, campaignId, campaignName, spend, clicks, conversions }]
 */
async function getDailyData(startDate, endDate) {
  if (!isConfigured()) return [];
  logger.info('Fetching Google Ads daily data', { startDate, endDate });

  try {
    const rows = await getCustomer().query(`
      SELECT
        segments.date,
        campaign.id, campaign.name,
        metrics.cost_micros, metrics.clicks, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
        AND campaign.status != 'REMOVED'
        AND metrics.cost_micros > 0
      ORDER BY segments.date ASC
    `);

    return rows.map(r => ({
      date:         r.segments.date,
      campaignId:   String(r.campaign.id),
      campaignName: r.campaign.name,
      source:       'google',
      spend:        (r.metrics.cost_micros || 0) / 1_000_000,
      clicks:       r.metrics.clicks || 0,
      conversions:  r.metrics.conversions || 0,
    }));
  } catch (err) {
    logger.error('Google Ads daily error', { error: err.message });
    return [];
  }
}

module.exports = { getCampaigns, getDailyData, isConfigured };
