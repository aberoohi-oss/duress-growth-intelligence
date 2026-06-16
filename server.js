console.log('[startup] process.version:', process.version);
console.log('[startup] NODE_ENV:', process.env.NODE_ENV);
console.log('[startup] loading dotenv...');
require('dotenv').config({ override: false });
console.log('[startup] dotenv loaded, PORT env:', process.env.PORT);

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const path = require('path');

const logger = require('./src/utils/logger');
const cache = require('./src/utils/cache');
const analyticsRouter = require('./src/routes/analytics');
const authRouter = require('./src/routes/auth');

const app = express();
const PORT = process.env.PORT;

// ─── Security & middleware ────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
        fontSrc: ["'self'", 'fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP request logging
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => req.url === '/health',
  })
);

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/analytics', analyticsRouter);
app.use('/auth', authRouter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache: cache.stats(),
    timestamp: new Date().toISOString(),
  });
});

// Catch-all: serve the SPA for any non-API, non-asset route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, url: req.url });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Auto-refresh cron (every 30 minutes) ────────────────────────────────────
cron.schedule('*/30 * * * *', () => {
  logger.info('Scheduled cache flush — data will be re-fetched on next request');
  cache.flush();
});

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('[startup] calling app.listen on PORT:', PORT);
app.listen(PORT, '0.0.0.0', () => {
  console.log('[startup] listen callback fired — server is up on port', PORT);
  logger.info(`Duress Growth Command running at http://localhost:${PORT}`, {
    env: process.env.NODE_ENV,
    port: PORT,
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = app;
