const pool = require("./config/db");

(async () => {

  const [existing] = await pool.query(
    "SHOW COLUMNS FROM notifications LIKE 'email_sent_at'"
  );

  if (existing.length > 0) {
    console.log("email_sent_at already exists — no change made.");
    process.exit(0);
  }

  await pool.query(
    "ALTER TABLE notifications ADD COLUMN email_sent_at TIMESTAMP NULL DEFAULT NULL AFTER is_read"
  );

  console.log("Added notifications.email_sent_at (TIMESTAMP NULL DEFAULT NULL).");

  const [cols] = await pool.query("SHOW COLUMNS FROM notifications");
  console.log(JSON.stringify(cols.map(c => c.Field), null, 1));

  process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
