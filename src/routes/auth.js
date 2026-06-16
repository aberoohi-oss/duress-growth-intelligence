const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

function saveTokenToEnv(key, value) {
  const envPath = path.join(process.cwd(), '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  const re = new RegExp(`^${key}=.*`, 'm');
  env = re.test(env) ? env.replace(re, `${key}=${value}`) : env + `\n${key}=${value}`;
  fs.writeFileSync(envPath, env);
  // Hot-reload into current process
  process.env[key] = value;
  logger.info(`Saved ${key} to .env`);
}

// GET /auth/google — redirect user to Google OAuth consent screen
router.get('/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    redirect_uri: `http://localhost:${process.env.PORT || 3000}/auth/google/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /auth/google/callback
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.status(400).send(`OAuth error: ${error || 'no code received'}`);
  }

  try {
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        redirect_uri: `http://localhost:${process.env.PORT || 3000}/auth/google/callback`,
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { refresh_token, access_token } = tokenRes.data;
    logger.info('Google OAuth token received');

    if (refresh_token) {
      saveTokenToEnv('GOOGLE_ADS_REFRESH_TOKEN', refresh_token);
    }

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>body{font-family:system-ui;background:#0b0d12;color:#e6e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .box{background:#11141c;border:1px solid #21263a;border-radius:10px;padding:2rem;max-width:560px;width:90%}
      h2{color:#34d399;margin-bottom:1rem}a{color:#4f7cff;text-decoration:none}.ok{color:#34d399}.warn{color:#f59e0b}</style></head><body>
      <div class="box">
        <h2>✓ Google Ads Connected</h2>
        ${refresh_token
          ? `<p class="ok">Refresh token saved automatically to <code>.env</code>.</p>`
          : `<p class="warn">No refresh token returned — ensure <code>access_type=offline</code> and <code>prompt=consent</code>.</p>`}
        <p style="margin-top:1.5rem"><a href="/">← Back to dashboard</a></p>
      </div></body></html>`);
  } catch (err) {
    logger.error('Google OAuth callback error', { error: err.message });
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

// GET /auth/microsoft — redirect to Microsoft OAuth consent screen
router.get('/microsoft', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_ADS_CLIENT_ID,
    redirect_uri: `http://localhost:${process.env.PORT || 3000}/auth/microsoft/callback`,
    response_type: 'code',
    scope: 'https://ads.microsoft.com/msads.manage offline_access',
    response_mode: 'query',
  });
  const tenant = process.env.MICROSOFT_ADS_TENANT_ID || 'common';
  res.redirect(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`);
});

// GET /auth/microsoft/callback
router.get('/microsoft/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) {
    return res.status(400).send(`OAuth error: ${error_description || error || 'no code received'}`);
  }

  try {
    const tenant = process.env.MICROSOFT_ADS_TENANT_ID || 'common';
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_ADS_CLIENT_ID,
        client_secret: process.env.MICROSOFT_ADS_CLIENT_SECRET,
        redirect_uri: `http://localhost:${process.env.PORT || 3000}/auth/microsoft/callback`,
        grant_type: 'authorization_code',
        scope: 'https://ads.microsoft.com/msads.manage offline_access',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { refresh_token, access_token } = tokenRes.data;
    logger.info('Microsoft Ads OAuth token received');

    if (refresh_token) {
      saveTokenToEnv('MICROSOFT_ADS_REFRESH_TOKEN', refresh_token);
    }

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>body{font-family:system-ui;background:#0b0d12;color:#e6e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .box{background:#11141c;border:1px solid #21263a;border-radius:10px;padding:2rem;max-width:560px;width:90%}
      h2{color:#34d399;margin-bottom:1rem}pre{background:#181c27;padding:1rem;border-radius:6px;overflow-x:auto;font-size:.8rem;word-break:break-all;white-space:pre-wrap}
      a{color:#4f7cff;text-decoration:none}.ok{color:#34d399}.warn{color:#f59e0b}</style></head><body>
      <div class="box">
        <h2>✓ Microsoft Ads Connected</h2>
        ${refresh_token
          ? `<p class="ok">Refresh token saved automatically to <code>.env</code>. The server will use it immediately — no restart needed.</p>`
          : `<p class="warn">No refresh token returned. Ensure <code>offline_access</code> scope is approved.</p>`}
        <p style="margin-top:1.5rem"><a href="/">← Back to dashboard</a></p>
      </div></body></html>`);
  } catch (err) {
    logger.error('Microsoft OAuth callback error', { error: err.message });
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

module.exports = router;
