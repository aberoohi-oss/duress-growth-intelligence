const {
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  subMonths,
  subQuarters,
  format,
  parseISO,
  isValid,
} = require('date-fns');

const DATE_FMT = 'yyyy-MM-dd';

function fmt(date) {
  return format(date, DATE_FMT);
}

const RANGES = {
  this_month: () => {
    const now = new Date();
    return { start: fmt(startOfMonth(now)), end: fmt(now) };
  },
  last_month: () => {
    const prev = subMonths(new Date(), 1);
    return { start: fmt(startOfMonth(prev)), end: fmt(endOfMonth(prev)) };
  },
  this_quarter: () => {
    const now = new Date();
    return { start: fmt(startOfQuarter(now)), end: fmt(now) };
  },
  last_quarter: () => {
    const prev = subQuarters(new Date(), 1);
    return { start: fmt(startOfQuarter(prev)), end: fmt(endOfQuarter(prev)) };
  },
};

function resolve(rangeKey, customStart, customEnd) {
  if (customStart && customEnd) {
    const s = parseISO(customStart);
    const e = parseISO(customEnd);
    if (!isValid(s) || !isValid(e)) throw new Error('Invalid custom date range');
    return { start: fmt(s), end: fmt(e) };
  }
  const fn = RANGES[rangeKey] || RANGES.this_month;
  return fn();
}

module.exports = { resolve, RANGES, DATE_FMT };
