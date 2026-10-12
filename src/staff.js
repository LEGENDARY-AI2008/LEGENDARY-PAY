// Support tools: balance adjustments, reversals, user search and an audit log.
// Support staff have users.staff_role = 'support' (set by an admin). Admins (ADMIN_EMAIL) can do everything.
// Every action is posted through the ledger with a reason, and written to staff_audit.
import crypto from 'node:crypto';
import { post, INSUFFICIENT } from './ledger.js';

// Limits for support staff, in kobo. Admins are not limited, but every action is still logged.
const ADJUST_MAX = Number(process.env.STAFF_ADJUST_MAX_KOBO || 2000000);  // ₦20,000 per action
const DAILY_MAX = Number(process.env.STAFF_DAILY_MAX_KOBO || 10000000);   // ₦100,000 per agent per day

// Only wallet-to-wallet moves and bonus-type credits can be reversed here.
// Money that left the app (bank transfers, deposits, delivered bills) cannot be pulled back by a ledger entry.
const REVERSIBLE = ['internal_transfer', 'cashback', 'bonus', 'referral'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mountStaff(app, d) {
  const { auth, h, q, tx, httpErr, notify, naira, isAdminUser, checkPin, enqueue } = d;
  // Unsubscribe links in broadcast emails need the public address of this API.
  const PUBLIC_API = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const unsubToken = (id) => crypto.createHmac('sha256', process.env.JWT_SECRET || 'x').update('unsub:' + id).digest('hex').slice(0, 32);

  // Checks the caller is support staff or an admin. Sets req.staff = { id, admin, role }.
  async function staffOnly(req, res, next) {
    auth(req, res, async (err) => {
      if (err) return next(err);
      try {
        const u = (await q('SELECT id, email, email_verified, staff_role FROM users WHERE id=$1 AND deleted_at IS NULL', [req.uid])).rows[0];
        if (!u) throw httpErr(401, 'Please sign in again');
        const admin = isAdminUser(u);
        if (!admin && u.staff_role !== 'support') throw httpErr(403, 'Staff only');
        req.staff = { id: u.id, admin, role: admin ? 'admin' : 'support' };
        next();
      } catch (e) { next(e); }
    });
  }

  const todayKobo = async (staffId) => Number((await q(
    `SELECT COALESCE(SUM(ABS(amount_kobo)),0) AS t FROM staff_audit WHERE staff_id=$1 AND created_at >= date_trunc('day', now())`,
    [staffId])).rows[0].t);

  // Search users by name, phone or virtual account number. Returns only what support needs.
  app.get('/staff/users', staffOnly, h(async (req, res) => {
    const term = String(req.query.q || '').trim();
    if (term.length < 4) throw httpErr(400, 'Type at least 4 characters');
    const rows = (await q(
      `SELECT u.id, u.full_name, u.phone, u.virtual_account, u.created_at, a.balance
         FROM users u
         LEFT JOIN accounts a ON a.code = 'u:' || u.id::text || ':main'
        WHERE u.deleted_at IS NULL
          AND (u.phone LIKE $1 OR u.full_name ILIKE $1 OR u.virtual_account = $2)
        ORDER BY u.full_name LIMIT 20`,
      [`%${term}%`, term])).rows;
    res.json({ users: rows.map((r) => ({
      id: r.id, name: r.full_name, phone: r.phone, virtualAccount: r.virtual_account,
      mainKobo: Number(r.balance || 0), joined: r.created_at,
    })) });
  }));

  // Adds money to, or takes money from, a user's wallet. Amount is in naira. Negative takes money out.
  app.post('/staff/adjust', staffOnly, h(async (req, res) => {
    const { userId, amount, reason, idemKey, pin, approval } = req.body || {};
    const kobo = Math.round(Number(amount) * 100);
    const why = String(reason || '').trim();
    if (!UUID_RE.test(String(userId || ''))) throw httpErr(400, 'Pick a user first');
    if (!Number.isSafeInteger(kobo) || kobo === 0) throw httpErr(400, 'Enter an amount (not zero)');
    if (why.length < 5) throw httpErr(400, 'Write the reason (at least 5 letters)');
    if (!idemKey) throw httpErr(400, 'Invalid request');
    await checkPin(req.uid, pin, approval);
    const abs = Math.abs(kobo);
    if (!req.staff.admin) {
      if (abs > ADJUST_MAX) throw httpErr(403, `Support can adjust up to ₦${(ADJUST_MAX / 100).toLocaleString('en-NG')} at a time. Ask an admin.`);
      if ((await todayKobo(req.staff.id)) + abs > DAILY_MAX) throw httpErr(403, 'You have reached your daily limit for adjustments.');
    }
    const target = (await q('SELECT id, full_name FROM users WHERE id=$1 AND deleted_at IS NULL', [userId])).rows[0];
    if (!target) throw httpErr(404, 'User not found');

    const idem = `staff-adj:${req.staff.id}:${idemKey}`;
    // Money in: system account pays the user. Money out: the user pays the system account.
    const legs = kobo > 0
      ? [{ account: 'sys:adjust', amount: -kobo }, { account: `u:${userId}:main`, amount: kobo }]
      : [{ account: `u:${userId}:main`, amount: kobo }, { account: 'sys:adjust', amount: -kobo }];
    try {
      await tx(async (c) => {
        const r = await post(c, { idem, kind: 'staff_adjust', userId, meta: { reason: why, by: req.staff.id }, legs });
        if (r.duplicate) return;
        await c.query(
          `INSERT INTO staff_audit(staff_id, action, target_user_id, amount_kobo, reason, ref) VALUES($1,'adjust',$2,$3,$4,$5)`,
          [req.staff.id, userId, kobo, why, idem]);
      });
    } catch (e) {
      if (INSUFFICIENT(e)) throw httpErr(400, 'This user does not have enough money for that adjustment.');
      throw e;
    }
    notify(userId, kobo > 0 ? 'Money added to your wallet' : 'Adjustment on your wallet',
      `Our support team made an adjustment of ${naira(abs)} ${kobo > 0 ? 'to' : 'from'} your wallet. If you have questions, contact support in the app.`);
    res.json({ ok: true, kobo });
  }));

  // Reverses a wallet-to-wallet transfer or a bonus credit, by posting the opposite entries.
  // The original stays in the history, and a reversal entry links to it.
  app.post('/staff/reverse', staffOnly, h(async (req, res) => {
    const { reference, reason, idemKey, pin, approval } = req.body || {};
    const ref = String(reference || '').trim();
    const why = String(reason || '').trim();
    if (!ref || why.length < 5 || !idemKey) throw httpErr(400, 'Enter the transaction reference and a reason (at least 5 letters)');
    await checkPin(req.uid, pin, approval);

    const j = (await q(
      `SELECT id, idem_key, kind, user_id FROM journal WHERE idem_key=$1 OR id::text=$1 LIMIT 1`, [ref])).rows[0];
    if (!j) throw httpErr(404, 'Transaction not found');
    if (!REVERSIBLE.includes(j.kind)) throw httpErr(400, 'This type of transaction cannot be reversed here. Ask an admin.');
    const done = (await q(`SELECT 1 FROM journal WHERE kind='reversal' AND meta->>'of'=$1 LIMIT 1`, [String(j.id)])).rows[0];
    if (done) throw httpErr(409, 'This transaction has already been reversed');

    // The amount that moved to or from user wallets. Used for the limit.
    const moved = Number((await q(
      `SELECT COALESCE(SUM(e.amount),0) AS t FROM entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.journal_id=$1 AND a.code LIKE 'u:%' AND e.amount > 0`, [j.id])).rows[0].t);
    if (!req.staff.admin) {
      if (moved > ADJUST_MAX) throw httpErr(403, `Support can reverse up to ₦${(ADJUST_MAX / 100).toLocaleString('en-NG')}. Ask an admin.`);
      if ((await todayKobo(req.staff.id)) + moved > DAILY_MAX) throw httpErr(403, 'You have reached your daily limit.');
    }

    const entries = (await q(
      `SELECT a.code, e.amount FROM entries e JOIN accounts a ON a.id = e.account_id WHERE e.journal_id=$1`, [j.id])).rows;
    const legs = entries.map((e) => ({ account: e.code, amount: -Number(e.amount) }));
    try {
      await tx(async (c) => {
        const r = await post(c, {
          idem: `reversal:${j.idem_key}`, kind: 'reversal', userId: j.user_id,
          meta: { of: String(j.id), reason: why, by: req.staff.id }, legs,
        });
        if (r.duplicate) return;
        await c.query(
          `INSERT INTO staff_audit(staff_id, action, target_user_id, amount_kobo, reason, ref) VALUES($1,'reverse',$2,$3,$4,$5)`,
          [req.staff.id, j.user_id, moved, why, j.idem_key]);
      });
    } catch (e) {
      if (INSUFFICIENT(e)) throw httpErr(400, 'Cannot reverse: the receiver has already spent some of this money.');
      throw e;
    }
    if (j.user_id) notify(j.user_id, 'A transaction was reversed', `A transaction on your wallet was reversed by our support team. If you have questions, contact support in the app.`);
    res.json({ ok: true, reversedKobo: moved });
  }));

  // Audit log. Admins see everything. Support sees their own actions.
  app.get('/staff/audit', staffOnly, h(async (req, res) => {
    const rows = (await q(
      `SELECT s.created_at, s.action, s.amount_kobo, s.reason, s.ref, s.target_user_id, st.full_name AS staff_name
         FROM staff_audit s JOIN users st ON st.id = s.staff_id
        WHERE ($1::boolean OR s.staff_id = $2)
        ORDER BY s.created_at DESC LIMIT 200`,
      [req.staff.admin, req.staff.id])).rows;
    res.json({ entries: rows.map((r) => ({
      at: r.created_at, action: r.action, amountKobo: Number(r.amount_kobo || 0), reason: r.reason,
      ref: r.ref, targetUserId: r.target_user_id, staff: r.staff_name,
    })) });
  }));

  // Admin only: give someone the support role, or take it away (role: 'support' or 'none').
  app.post('/admin/staff', staffOnly, h(async (req, res) => {
    if (!req.staff.admin) throw httpErr(403, 'Admins only');
    const { email, role } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    const r = role === 'support' ? 'support' : null;
    if (!em) throw httpErr(400, 'Enter an email');
    const u = (await q('UPDATE users SET staff_role=$2 WHERE email=$1 AND deleted_at IS NULL RETURNING id', [em, r])).rows[0];
    if (!u) throw httpErr(404, 'No account with that email');
    await q(
      `INSERT INTO staff_audit(staff_id, action, target_user_id, amount_kobo, reason, ref) VALUES($1,'role',$2,0,$3,NULL)`,
      [req.staff.id, u.id, r ? 'made support staff' : 'removed from support']);
    res.json({ ok: true, role: r });
  }));

  // Admin only: email every verified user who has not opted out. Sent one by one through the job queue.
  app.post('/admin/broadcast', staffOnly, h(async (req, res) => {
    if (!req.staff.admin) throw httpErr(403, 'Admins only');
    const subject = String(req.body?.subject || '').trim().slice(0, 150);
    const text = String(req.body?.text || '').trim().slice(0, 5000);
    if (subject.length < 3 || text.length < 10) throw httpErr(400, 'Write a subject and a message');
    await checkPin(req.uid, req.body?.pin, req.body?.approval);
    const users = (await q(
      `SELECT id, email FROM users WHERE email_verified = true AND deleted_at IS NULL AND email IS NOT NULL AND marketing_opt_out = false`)).rows;
    for (const u of users) {
      const link = PUBLIC_API ? `\n\nTo stop these emails: ${PUBLIC_API}/unsubscribe?u=${u.id}&t=${unsubToken(u.id)}` : '';
      await enqueue(null, 'send_mail', { to: u.email, subject, text: text + link });
    }
    await enqueue(null, 'push_all', { title: subject, body: text.slice(0, 140) });
    await q(
      `INSERT INTO staff_audit(staff_id, action, target_user_id, amount_kobo, reason, ref) VALUES($1,'broadcast',NULL,0,$2,NULL)`,
      [req.staff.id, `${subject} (${users.length} recipients)`]);
    res.json({ ok: true, queued: users.length });
  }));

  // Public link from broadcast emails. Turns off broadcast emails for that user only.
  app.get('/unsubscribe', h(async (req, res) => {
    const id = String(req.query.u || '');
    const t = String(req.query.t || '');
    const page = (msg) => res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:24px"><p>${msg}</p></body>`);
    if (!UUID_RE.test(id) || t !== unsubToken(id)) return page('This link is not valid.');
    await q('UPDATE users SET marketing_opt_out = true WHERE id = $1', [id]);
    page('You have been unsubscribed from Legendary Pay emails. You will still get account and security emails.');
  }));

  // Admin only: record the interest our money-holding partner paid us for a month.
  // Books it as income (sys:revenue), so it counts in profit. Each month can only be entered once.
  app.post('/admin/interest', staffOnly, h(async (req, res) => {
    if (!req.staff.admin) throw httpErr(403, 'Admins only');
    const { month, amount, note, pin, approval } = req.body || {};
    const m = String(month || '');
    const kobo = Math.round(Number(amount) * 100);
    const why = String(note || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw httpErr(400, 'Pick the month');
    if (!Number.isSafeInteger(kobo) || kobo <= 0) throw httpErr(400, 'Enter the interest amount');
    if (why.length < 3) throw httpErr(400, 'Write where the interest came from (e.g. Flutterwave statement, July)');
    await checkPin(req.uid, pin, approval);
    const idem = `interest:${m}`;
    try {
      await tx(async (c) => {
        const r = await post(c, {
          idem, kind: 'interest', userId: null, meta: { month: m, note: why, by: req.uid },
          legs: [{ account: 'sys:external', amount: -kobo }, { account: 'sys:revenue', amount: kobo }],
        });
        if (r.duplicate) throw httpErr(409, `Interest for ${m} is already entered`);
        await c.query(
          `INSERT INTO staff_audit(staff_id, action, target_user_id, amount_kobo, reason, ref) VALUES($1,'interest',NULL,$2,$3,$4)`,
          [req.uid, kobo, why, idem]);
      });
    } catch (e) {
      throw e;
    }
    res.json({ ok: true, kobo });
  }));
}
