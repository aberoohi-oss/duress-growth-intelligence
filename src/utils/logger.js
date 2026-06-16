const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = path.join(process.cwd(), 'logs');

// File transports are optional — Railway and similar platforms may have
// a read-only filesystem, so we fall back to console-only if needed.
const fileTransports = [];
try {
  require('winston-daily-rotate-file');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fileTransports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(logDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true,
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '30d',
      zippedArchive: true,
    })
  );
} catch (e) {
  console.warn('[logger] File transports unavailable, using console only:', e.message);
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: fileTransports,
});

// Always log to console so Railway/hosted stdout captures output
logger.add(
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level}: ${message}${extra}`;
      })
    ),
  })
);

module.exports = logger;
