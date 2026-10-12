// Web push notifications (phones and computers that installed the app or allowed alerts).
// Keys are created once and saved in the database, unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set on Render.
import webpush from 'web-push';
import { q } from './db.js';

let keys = null;

async function vapid() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const fresh = webpush.generateVAPIDKeys();
    await q(`INSERT INTO app_kv(key, value) VALUES('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(fresh)]);
    const row = (await q(`SELECT value FROM app_kv WHERE key='vapid'`)).rows[0];
    keys = JSON.parse(row.value);
  }
  const contact = process.env.ADMIN_EMAIL ? `mailto:${process.env.ADMIN_EMAIL}` : 'mailto:support@example.com';
  webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);
  return keys;
}

// Sends one payload to every device a user has subscribed. Dead subscriptions are removed.
async function sendToSubs(subs, payload) {
  const body = JSON.stringify({ title: payload.title || 'Legendary Pay', body: payload.body || '', url: payload.url || '/' });
  await Promise.all(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400 })
      .catch(async (e) => {
        if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
        else console.error('push failed', e.statusCode || e.message);
      })));
}

export async function pushUsers(userIds, payload) {
  if (!userIds.length) return;
  await vapid();
  const subs = (await q(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`, [userIds])).rows;
  await sendToSubs(subs, payload);
}

// Support staff and admins (new live chat messages).
export async function pushToStaff(payload) {
  await vapid();
  const admin = process.env.ADMIN_EMAIL || '';
  const subs = (await q(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.id = s.user_id
      WHERE u.deleted_at IS NULL AND (u.staff_role = 'support' OR ($1 <> '' AND u.email = $1))`, [admin])).rows;
  await sendToSubs(subs, payload);
}

// Every subscribed device (used for update announcements). Works through the list in pages.
export async function pushAll(payload) {
  await vapid();
  let last = 0;
  for (;;) {
    const page = (await q(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE id > $1 ORDER BY id LIMIT 200`, [last])).rows;
    if (!page.length) break;
    await sendToSubs(page, payload);
    last = Number(page[page.length - 1].id);
    if (page.length < 200) break;
  }
}

// Routes: the browser asks for the public key, then saves its subscription.
export function mountPush(app, d) {
  const { auth, h, q: query, httpErr } = d;
  const UUID = /^[0-9a-f-]{36}$/i;

  app.get('/push/key', h(async (_req, res) => {
    const k = await vapid();
    res.json({ publicKey: k.publicKey });
  }));

  app.post('/push/subscribe', auth, h(async (req, res) => {
    const s = req.body?.endpoint ? req.body : null;
    const endpoint = String(s?.endpoint || '');
    const p256dh = String(s?.keys?.p256dh || '');
    const authKey = String(s?.keys?.auth || '');
    if (!/^https:\/\//.test(endpoint) || !p256dh || !authKey) throw httpErr(400, 'Notification setup failed. Try again.');
    await query(
      `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.uid, endpoint, p256dh, authKey]);
    res.json({ ok: true });
  }));

  app.post('/push/unsubscribe', auth, h(async (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    await query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [endpoint, req.uid]);
    res.json({ ok: true });
  }));
}
