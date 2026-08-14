/**
 * timeUtils.js — Israel timezone utilities for watchdog and health checks.
 */

function getIsraelHour(now = Date.now()) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem',
      hour: 'numeric',
      hour12: false
    }).format(now),
    10
  );
}

module.exports = { getIsraelHour };
