/**
 * check-calendar-auth.js
 * Checks OAuth token validity for Aviv and Liat.
 * Outputs JSON: { aviv: {ok, error?}, liat: {ok, error?}, aviv_url?, liat_url? }
 * Used by Morning Digest to detect and surface auth failures.
 */
const _log = console.log; console.log = () => {};
const { initDB } = require('./src/db');
initDB();
console.log = _log;

const { verifyCalendarAuth, generateAuthUrl } = require('./src/calendar');
const cfg = require('./src/config');

async function check() {
  const [aviv, liat] = await Promise.all([
    verifyCalendarAuth(cfg.AVIV_TOKEN_PATH),
    verifyCalendarAuth(cfg.LIAT_TOKEN_PATH),
  ]);

  const result = { aviv, liat };
  if (!aviv.ok) result.aviv_url = generateAuthUrl('avivbes1@gmail.com');
  if (!liat.ok) result.liat_url = generateAuthUrl('liat.elm@gmail.com');

  console.log(JSON.stringify(result));
}

check().catch(e => {
  console.log(JSON.stringify({ aviv: { ok: false, error: e.message }, liat: { ok: false, error: e.message } }));
});
