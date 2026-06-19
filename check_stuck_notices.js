
const {initDB,getDB}=require('./src/db');initDB();
const stuck=getDB().prepare(`
  SELECT id, group_name, content, relevance_date, relevance_time, send_attempted_at
  FROM notices
  WHERE send_attempted_at IS NOT NULL
    AND sent_to_master=0
    AND datetime(send_attempted_at) < datetime('now','-2 hours')
  ORDER BY send_attempted_at DESC
`).all();
console.log(JSON.stringify(stuck));
