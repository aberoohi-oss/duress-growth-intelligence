const axios = require('axios');
const unzipper = require('unzipper');
const { parseStringPromise } = require('xml2js');
const { parse: parseCSV } = require('csv-parse/sync');
const logger = require('../utils/logger');

const REPORTING_URL =
  'https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc';

let _tokenCache = null;

function isConfigured() {
  return !!(
    process.env.MICROSOFT_ADS_CLIENT_ID &&
    process.env.MICROSOFT_ADS_CLIENT_SECRET &&
    process.env.MICROSOFT_ADS_REFRESH_TOKEN &&
    process.env.MICROSOFT_ADS_DEVELOPER_TOKEN &&
    process.env.MICROSOFT_ADS_ACCOUNT_ID &&
    process.env.MICROSOFT_ADS_CUSTOMER_ID
  );
}

function tokenUrl() {
  const tenant = process.env.MICROSOFT_ADS_TENANT_ID || 'common';
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) return _tokenCache.accessToken;
  const res = await axios.post(
    tokenUrl(),
    new URLSearchParams({
      client_id:     process.env.MICROSOFT_ADS_CLIENT_ID,
      client_secret: process.env.MICROSOFT_ADS_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: process.env.MICROSOFT_ADS_REFRESH_TOKEN,
      scope:         'https://ads.microsoft.com/msads.manage offline_access',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _tokenCache = {
    accessToken: res.data.access_token,
    expiresAt:   Date.now() + (res.data.expires_in - 60) * 1000,
  };
  return _tokenCache.accessToken;
}

function soapHeaders(token) {
  return `
    <AuthenticationToken>${token}</AuthenticationToken>
    <CustomerId>${process.env.MICROSOFT_ADS_CUSTOMER_ID}</CustomerId>
    <AccountId>${process.env.MICROSOFT_ADS_ACCOUNT_ID}</AccountId>
    <DeveloperToken>${process.env.MICROSOFT_ADS_DEVELOPER_TOKEN}</DeveloperToken>`;
}

function dateXml(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `<Day>${parseInt(d, 10)}</Day><Month>${parseInt(m, 10)}</Month><Year>${y}</Year>`;
}

function buildReportXml(token, startDate, endDate, aggregation = 'Summary') {
  // TimePeriod column is only valid for non-Summary aggregations
  const timePeriodCol = aggregation !== 'Summary'
    ? '<CampaignPerformanceReportColumn>TimePeriod</CampaignPerformanceReportColumn>'
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header xmlns="https://bingads.microsoft.com/Reporting/v13">
    <Action mustUnderstand="1">SubmitGenerateReport</Action>
    ${soapHeaders(token)}
  </s:Header>
  <s:Body>
    <SubmitGenerateReportRequest xmlns="https://bingads.microsoft.com/Reporting/v13">
      <ReportRequest i:type="CampaignPerformanceReportRequest">
        <Format>Csv</Format>
        <Language>English</Language>
        <ReportName>DGC_${aggregation}</ReportName>
        <ReturnOnlyCompleteData>false</ReturnOnlyCompleteData>
        <Aggregation>${aggregation}</Aggregation>
        <Columns>
          ${timePeriodCol}
          <CampaignPerformanceReportColumn>CampaignId</CampaignPerformanceReportColumn>
          <CampaignPerformanceReportColumn>CampaignName</CampaignPerformanceReportColumn>
          <CampaignPerformanceReportColumn>Impressions</CampaignPerformanceReportColumn>
          <CampaignPerformanceReportColumn>Clicks</CampaignPerformanceReportColumn>
          <CampaignPerformanceReportColumn>Spend</CampaignPerformanceReportColumn>
          <CampaignPerformanceReportColumn>Conversions</CampaignPerformanceReportColumn>
        </Columns>
        <Scope>
          <AccountIds xmlns:a1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
            <a1:long>${process.env.MICROSOFT_ADS_ACCOUNT_ID}</a1:long>
          </AccountIds>
        </Scope>
        <Time>
          <CustomDateRangeEnd>${dateXml(endDate)}</CustomDateRangeEnd>
          <CustomDateRangeStart>${dateXml(startDate)}</CustomDateRangeStart>
          <PredefinedTime i:nil="true" />
          <ReportTimeZone i:nil="true" />
        </Time>
      </ReportRequest>
    </SubmitGenerateReportRequest>
  </s:Body>
</s:Envelope>`;
}

function buildPollXml(token, reportRequestId) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header xmlns="https://bingads.microsoft.com/Reporting/v13">
    <Action mustUnderstand="1">PollGenerateReport</Action>
    ${soapHeaders(token)}
  </s:Header>
  <s:Body>
    <PollGenerateReportRequest xmlns="https://bingads.microsoft.com/Reporting/v13">
      <ReportRequestId>${reportRequestId}</ReportRequestId>
    </PollGenerateReportRequest>
  </s:Body>
</s:Envelope>`;
}

async function soapPost(xml, action) {
  const res = await axios.post(REPORTING_URL, xml, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` },
    timeout: 30_000,
  });
  return parseStringPromise(res.data, { explicitArray: false, ignoreAttrs: true });
}

function checkFault(parsed) {
  const fault = parsed?.['s:Envelope']?.['s:Body']?.['s:Fault'];
  if (fault) {
    const op = fault?.detail?.ApiFaultDetail?.OperationErrors?.OperationError;
    const msg = op?.Message || op?.ErrorCode || fault.faultstring;
    throw new Error(`Microsoft Ads SOAP fault: ${msg}`);
  }
}

// Microsoft Ads reports require the end date to be fully complete (not today)
function clampEndDate(endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDate + 'T00:00:00');
  if (end >= today) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().slice(0, 10);
  }
  return endDate;
}

async function runReport(token, startDate, endDate, aggregation = 'Summary') {
  const safeEnd = clampEndDate(endDate);
  const submitXml = buildReportXml(token, startDate, safeEnd, aggregation);
  const submitted = await soapPost(submitXml, 'SubmitGenerateReport');
  checkFault(submitted);
  const reportRequestId =
    submitted['s:Envelope']['s:Body'].SubmitGenerateReportResponse.ReportRequestId;

  for (let i = 0; i < 30; i++) {
    const pollXml = buildPollXml(token, reportRequestId);
    const polled  = await soapPost(pollXml, 'PollGenerateReport');
    checkFault(polled);
    const status  = polled['s:Envelope']['s:Body'].PollGenerateReportResponse.ReportRequestStatus;
    logger.debug('Microsoft Ads poll', { attempt: i + 1, status: status.Status });
    if (status.Status === 'Success') return status.ReportDownloadUrl;
    if (status.Status === 'Error' || status.Status === 'Failed') throw new Error('Microsoft report failed');
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Microsoft report timed out');
}

function parseRow(r) {
  const clean = (v) => parseFloat((v || '0').toString().replace(/[^0-9.-]/g, '')) || 0;
  return {
    date:        r.TimePeriod || '',
    campaignId:  `bing_${r.CampaignId || ''}`,
    campaignName: r.CampaignName || '',
    source:      'bing',
    spend:       clean(r.Spend),
    clicks:      Math.round(clean(r.Clicks)),
    impressions: Math.round(clean(r.Impressions)),
    conversions: clean(r.Conversions),
  };
}

async function downloadAndParse(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
  const buf = Buffer.from(res.data);
  let text;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = await unzipper.Open.buffer(buf);
    const content = await zip.files[0].buffer();
    text = content.toString('utf8');
  } else {
    text = buf.toString('utf8');
  }
  const lines = text.replace(/\r/g, '').split('\n');
  const headerIdx = lines.findIndex(l => /CampaignId|Campaign Id/i.test(l));
  if (headerIdx === -1) return [];
  // Take only lines from header up to the first blank line after the header
  const dataLines = [lines[headerIdx]];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') break;
    dataLines.push(lines[i]);
  }
  return parseCSV(dataLines.join('\n'), { columns: true, skip_empty_lines: true, trim: true, relax_quotes: true });
}

/**
 * Summary campaign metrics for the date range.
 */
async function getCampaigns(startDate, endDate) {
  if (!isConfigured()) { logger.warn('Microsoft Ads not configured — skipping'); return []; }
  logger.info('Fetching Microsoft Ads campaigns', { startDate, endDate });
  try {
    const token = await getAccessToken();
    const url   = await runReport(token, startDate, endDate, 'Summary');
    const rows  = await downloadAndParse(url);
    const campaigns = rows.map(r => {
      const p = parseRow(r);
      return { id: p.campaignId, name: p.campaignName, source: 'bing', spend: p.spend, clicks: p.clicks, impressions: p.impressions, conversions: p.conversions };
    });
    logger.info(`Microsoft Ads: ${campaigns.length} campaigns`);
    return campaigns;
  } catch (err) {
    logger.error('Microsoft Ads error', { error: err.message });
    throw new Error(`Microsoft Ads error: ${err.message}`);
  }
}

/**
 * Daily spend per campaign for time-series charts.
 */
async function getDailyData(startDate, endDate) {
  if (!isConfigured()) return [];
  logger.info('Fetching Microsoft Ads daily data', { startDate, endDate });
  try {
    const token = await getAccessToken();
    const url   = await runReport(token, startDate, endDate, 'Daily');
    const rows  = await downloadAndParse(url);
    return rows.map(r => {
      const p = parseRow(r);
      // TimePeriod in Daily reports comes as M/D/YYYY — normalise to YYYY-MM-DD
      const raw = p.date;
      let date = raw;
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
        const [mo, dy, yr] = raw.split('/');
        date = `${yr}-${mo.padStart(2,'0')}-${dy.padStart(2,'0')}`;
      }
      return { ...p, date };
    });
  } catch (err) {
    logger.error('Microsoft Ads daily error', { error: err.message });
    return [];
  }
}

module.exports = { getCampaigns, getDailyData, isConfigured };
