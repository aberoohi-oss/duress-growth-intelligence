const hubspot = require('@hubspot/api-client');
const logger = require('../utils/logger');

let _client = null;
function getClient() {
  if (!_client) _client = new hubspot.Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });
  return _client;
}

function isConfigured() { return !!process.env.HUBSPOT_ACCESS_TOKEN; }

// ─── Constants ────────────────────────────────────────────────────────────────
const SALES_PIPELINE_ID  = '655395635';
const CLOSE_WON_STAGE    = '1176703755';
const CLOSE_LOST_STAGE   = '1176703756';  // terminal — excluded from pipeline
const DISQUALIFIED_STAGE = '2507535803';  // terminal — excluded from pipeline

const LEAD_PROPERTIES = [
  'createdate',
  'utm_campaign', 'utm_source', 'utm_medium',
  'hs_analytics_source', 'hs_analytics_source_data_1', 'hs_analytics_source_data_2',
  'recent_conversion_event_name', 'first_conversion_event_name',
];

const DEAL_PROPERTIES = [
  'dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'createdate', 'hs_is_closed_won',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function paginate(searchFn, filterGroups, properties, extraOpts = {}) {
  let all = [], after;
  do {
    const r = await searchFn({ filterGroups, properties, limit: 100, after, ...extraOpts });
    all = all.concat(r.results || []);
    after = r.paging?.next?.after;
  } while (after);
  return all;
}

// ─── Leads ────────────────────────────────────────────────────────────────────
/**
 * All contacts created within the date range.
 * attribution.js classifies them by utm_source / hs_analytics_source.
 */
async function getLeads(startDate, endDate) {
  if (!isConfigured()) { logger.warn('HubSpot not configured — skipping leads'); return []; }

  const startTs = new Date(startDate).getTime();
  const endTs   = new Date(endDate + 'T23:59:59').getTime();
  const client  = getClient();

  logger.info('Fetching HubSpot leads', { startDate, endDate });

  try {
    const results = await paginate(
      (opts) => client.crm.contacts.searchApi.doSearch(opts),
      [{
        filters: [
          { propertyName: 'createdate', operator: 'GTE', value: String(startTs) },
          { propertyName: 'createdate', operator: 'LTE', value: String(endTs) },
        ],
      }],
      LEAD_PROPERTIES,
      { sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }] }
    );
    logger.info(`HubSpot: ${results.length} leads fetched`);
    return results;
  } catch (err) {
    logger.error('HubSpot leads error', { error: err.message });
    throw new Error(`HubSpot leads error: ${err.message}`);
  }
}

// ─── Deals / Revenue ─────────────────────────────────────────────────────────
/**
 * All deals from the Sales pipeline, optionally filtered by close date range.
 * Returns aggregate revenue stats + per-month closed revenue for time-series.
 */
async function getPaidOpenPipeline(startTs, endTs, client) {
  // Contacts created in range with paid attribution (OR across 3 filter groups)
  const paidContacts = await paginate(
    opts => client.crm.contacts.searchApi.doSearch(opts),
    [
      { filters: [
        { propertyName: 'createdate',          operator: 'GTE', value: String(startTs) },
        { propertyName: 'createdate',          operator: 'LTE', value: String(endTs)   },
        { propertyName: 'utm_source',          operator: 'EQ',  value: 'google'        },
      ]},
      { filters: [
        { propertyName: 'createdate',          operator: 'GTE', value: String(startTs) },
        { propertyName: 'createdate',          operator: 'LTE', value: String(endTs)   },
        { propertyName: 'utm_source',          operator: 'EQ',  value: 'bing'          },
      ]},
      { filters: [
        { propertyName: 'createdate',          operator: 'GTE', value: String(startTs) },
        { propertyName: 'createdate',          operator: 'LTE', value: String(endTs)   },
        { propertyName: 'hs_analytics_source', operator: 'EQ',  value: 'PAID_SEARCH'  },
      ]},
    ],
    ['createdate']
  );

  if (!paidContacts.length) return 0;
  logger.info(`Paid contacts for pipeline lookup: ${paidContacts.length}`);

  // Batch-fetch contact→deal associations (100 per call)
  const dealIdSet = new Set();
  for (let i = 0; i < paidContacts.length; i += 100) {
    const chunk = paidContacts.slice(i, i + 100);
    const res = await client.crm.associations.batchApi.read('contacts', 'deals', {
      inputs: chunk.map(c => ({ id: c.id })),
    });
    for (const r of (res.results || [])) {
      for (const t of (r.to || [])) dealIdSet.add(t.id);
    }
  }

  if (!dealIdSet.size) return 0;

  // Batch-read deals and sum open pipeline value
  const dealIds = [...dealIdSet];
  let paidPipeline = 0;
  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    const res = await client.crm.deals.batchApi.read({
      inputs: chunk.map(id => ({ id })),
      properties: ['dealstage', 'pipeline', 'amount'],
    });
    for (const d of (res.results || [])) {
      const p = d.properties;
      if (
        p.pipeline === SALES_PIPELINE_ID &&
        ![CLOSE_WON_STAGE, CLOSE_LOST_STAGE, DISQUALIFIED_STAGE].includes(p.dealstage)
      ) {
        paidPipeline += parseFloat(p.amount || 0);
      }
    }
  }

  logger.info(`Paid open pipeline: ${paidPipeline.toFixed(2)} from ${dealIdSet.size} associated deals`);
  return paidPipeline;
}

async function getDealRevenue(startDate, endDate) {
  if (!isConfigured()) { logger.warn('HubSpot not configured — skipping deals'); return emptyRevenue(); }

  const startTs = new Date(startDate).getTime();
  const endTs   = new Date(endDate + 'T23:59:59').getTime();
  const client  = getClient();

  logger.info('Fetching HubSpot deal revenue', { startDate, endDate });

  try {
    // All open (non-terminal) deals in Sales pipeline — pipeline value
    const openDeals = await paginate(
      (opts) => client.crm.deals.searchApi.doSearch(opts),
      [{
        filters: [
          { propertyName: 'pipeline',   operator: 'EQ',     value: SALES_PIPELINE_ID },
          { propertyName: 'dealstage',  operator: 'NOT_IN', values: [CLOSE_WON_STAGE, CLOSE_LOST_STAGE, DISQUALIFIED_STAGE] },
          { propertyName: 'createdate', operator: 'GTE',    value: String(startTs) },
          { propertyName: 'createdate', operator: 'LTE',    value: String(endTs) },
        ],
      }],
      DEAL_PROPERTIES
    );

    // Closed won deals in the date range
    const wonDeals = await paginate(
      (opts) => client.crm.deals.searchApi.doSearch(opts),
      [{
        filters: [
          { propertyName: 'pipeline',  operator: 'EQ',           value: SALES_PIPELINE_ID },
          { propertyName: 'dealstage', operator: 'EQ',           value: CLOSE_WON_STAGE },
          { propertyName: 'amount',    operator: 'HAS_PROPERTY' },
          { propertyName: 'closedate', operator: 'GTE',          value: String(startTs) },
          { propertyName: 'closedate', operator: 'LTE',          value: String(endTs) },
        ],
      }],
      DEAL_PROPERTIES
    );

    // Open pipeline attributed to paid contacts only
    const paidPipelineValue = await getPaidOpenPipeline(startTs, endTs, client);

    const pipelineValue = openDeals.reduce((s, d) => s + parseFloat(d.properties.amount || 0), 0);
    const closedRevenue = wonDeals.reduce((s, d) =>  s + parseFloat(d.properties.amount || 0), 0);

    // Daily closed revenue for time-series
    const dailyRevenue = {};
    wonDeals.forEach(d => {
      const day = (d.properties.closedate || '').slice(0, 10);
      if (day) dailyRevenue[day] = (dailyRevenue[day] || 0) + parseFloat(d.properties.amount || 0);
    });

    logger.info('HubSpot revenue', {
      openDeals:        openDeals.length,
      wonDeals:         wonDeals.length,
      pipelineValue:    pipelineValue.toFixed(2),
      paidPipelineValue: paidPipelineValue.toFixed(2),
      closedRevenue:    closedRevenue.toFixed(2),
    });

    return {
      openDealCount:    openDeals.length,
      wonDealCount:     wonDeals.length,
      pipelineValue,
      paidPipelineValue,
      closedRevenue,
      dailyRevenue,
    };
  } catch (err) {
    logger.error('HubSpot deals error', { error: err.message });
    throw new Error(`HubSpot deals error: ${err.message}`);
  }
}

function emptyRevenue() {
  return { openDealCount: 0, wonDealCount: 0, pipelineValue: 0, closedRevenue: 0, dailyRevenue: {} };
}

module.exports = { getLeads, getDealRevenue, isConfigured, SALES_PIPELINE_ID, CLOSE_WON_STAGE };
