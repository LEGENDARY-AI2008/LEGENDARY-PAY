import { tx, q, settings } from './db.js';
import { post } from './ledger.js';

export async function queueGrant(c, userId, type, ref, amount) {
  if (amount <= 0) return;
  await c.query(
    `INSERT INTO bonus_grants(user_id, type, ref, amount) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [userId, type, String(ref), amount]
  );
}

// Decide who is owed welcome / referral bonuses. Safe to run any number of times.
export async function evaluateUser(userId) {
  await tx(async (c) => {
    const s = await settings(c);
    const u = (await c.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    if (!u || !u.kyc_verified) return;
    const dep = Number((await c.query(
      `SELECT COALESCE(SUM((meta->>'amount')::bigint),0) AS t FROM journal WHERE kind='deposit' AND user_id=$1`, [userId]
    )).rows[0].t);
    if (dep < s.min_deposit) return;

    await queueGrant(c, userId, 'welcome', '', s.welcome_bonus);

    if (!u.referred_by) return;
    const r = (await c.query('SELECT id, device_id FROM users WHERE id=$1', [u.referred_by])).rows[0];
    if (!r || r.id === u.id) return;
    if (u.device_id && r.device_id === u.device_id) return; // same device = self-referral
    const n = Number((await c.query(
      `SELECT COUNT(*) AS n FROM bonus_grants WHERE user_id=$1 AND type='referral' AND status<>'void'
       AND created_at > now() - interval '30 days'`, [r.id]
    )).rows[0].n);
    if (n >= s.referral_monthly_cap) return;
    await queueGrant(c, r.id, 'referral', u.id, s.referral_reward);
  });
}

// Pay pending grants FIFO, only from real pool money and under the daily cap. Stops when either runs out.
export async function releasePending() {
  const s = await settings();
  const ids = (await q(`SELECT id FROM bonus_grants WHERE status='pending' ORDER BY id LIMIT 100`)).rows.map((r) => r.id);
  for (const id of ids) {
    let stop = false;
    await tx(async (c) => {
      const g = (await c.query(
        `SELECT * FROM bonus_grants WHERE id=$1 AND status='pending' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!g) return;
      const amount = Number(g.amount);
      const pool = Number((await c.query(`SELECT balance FROM accounts WHERE code='sys:pool' FOR UPDATE`)).rows[0].balance);
      const today = Number((await c.query(
        `SELECT COALESCE(SUM(amount),0) AS t FROM bonus_grants WHERE status='paid' AND paid_at >= date_trunc('day', now())`
      )).rows[0].t);
      if (pool < amount || today + amount > s.daily_bonus_cap) { stop = true; return; }
      await post(c, {
        idem: `grant:${g.id}`, kind: 'bonus', userId: g.user_id, meta: { type: g.type },
        legs: [{ account: 'sys:pool', amount: -amount }, { account: `u:${g.user_id}:bonus`, amount }],
      });
      await c.query(`UPDATE bonus_grants SET status='paid', paid_at=now() WHERE id=$1`, [g.id]);
    });
    if (stop) break;
  }
}

// Bonus money becomes spendable/withdrawable only after enough real transfers (anti-abuse).
export async function unlockBonus(userId) {
  await tx(async (c) => {
    const s = await settings(c);
    const n = Number((await c.query(
      `SELECT COUNT(*) AS n FROM journal WHERE user_id=$1 AND kind IN ('internal_transfer','bank_transfer')`, [userId]
    )).rows[0].n);
    if (n < s.unlock_tx_count) return;
    const last = (await c.query(
      `SELECT COALESCE(MAX(id),0) AS m FROM bonus_grants WHERE user_id=$1 AND status='paid'`, [userId])).rows[0].m;
    const bal = Number((await c.query(
      `SELECT balance FROM accounts WHERE code=$1 FOR UPDATE`, [`u:${userId}:bonus`])).rows[0].balance);
    if (bal <= 0) return;
    await post(c, {
      idem: `unlock:${userId}:${last}`, kind: 'unlock', userId,
      legs: [{ account: `u:${userId}:bonus`, amount: -bal }, { account: `u:${userId}:main`, amount: bal }],
    });
  });
}
