const d = require('./src/db');
const c = require('./src/calendar');
const cfg = require('./src/config');
d.initDB();

async function check() {
  const [aviv, liat, liatWork] = await Promise.all([
    c.getTodayEvents(cfg.AVIV_CALENDAR_ID, cfg.AVIV_TOKEN_PATH),
    c.getTodayEvents(cfg.LIAT_CALENDAR_ID, cfg.LIAT_TOKEN_PATH),
    cfg.LIAT_WORK_CALENDAR_ID ? c.getTodayEvents(cfg.LIAT_WORK_CALENDAR_ID, cfg.LIAT_TOKEN_PATH) : Promise.resolve([])
  ]);
  console.log('Aviv events:', JSON.stringify(aviv.map(e => ({summary: e.summary, start: e.start})), null, 2));
  console.log('Liat events:', JSON.stringify(liat.map(e => ({summary: e.summary, start: e.start})), null, 2));
  console.log('LiatWork events:', JSON.stringify(liatWork.map(e => ({summary: e.summary, start: e.start})), null, 2));
}
check().catch(console.error);
