// Extra features: notifications, money requests, split bills, reminders, daily check-in,
// budgets and insights, scheduled transfers and savings, leaderboard, recent contacts, limits.
// Mounted from server.js with the helpers it needs, so this file stays independent of server state.
import { post } from './ledger.js';

const BUDGET_CATEGORIES = ['internal_transfer', 'bank_transfer', 'bill_airtime', 'goal_deposit'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function mountFeatures(app, d) {
  const { auth, h, q, tx, httpErr, validAmount, checkPin, requireEmailVerified, naira, maskName, notifyUser, settings } = d;

  // Creates one request per wallet number. Used by single and split requests.
  async function createRequests(uid, accounts, amount, note) {
    if (!validAmount(amount)) throw httpErr(400, 'Enter an amount between ₦10 and ₦500,000');
    const list = [...new Set(accounts.map((a) => String(a).trim()).filter(Boolean))];
    if (!list.length || list.length > 20 || list.some((a) => !/^\d{10}$/.test(a))) {
      throw httpErr(400, 'Enter valid 10-digit wallet numbers');
    }
    const me = (await q('SELECT full_name FROM users WHERE id=$1', [uid])).rows[0];
    const targets = (await q('SELECT id, account_number FROM users WHERE account_number = ANY($1)', [list])).rows;
    if (targets.length !== list.length) throw httpErr(400, 'One of those wallet numbers was not found');
    if (targets.some((t) => t.id === uid)) throw httpErr(400, 'You cannot request money from yourself');
    const cleanNote = String(note || '').trim().slice(0, 60);
    for (const t of targets) {
      await q('INSERT INTO money_requests(from_user, to_user, amount, note) VALUES($1,$2,$3,$4)', [uid, t.id, amount, cleanNote]);
      notifyUser(t.id, 'Payment request', `${maskName(me?.full_name)} asked you to pay ${naira(amount)}${cleanNote ? ': ' + cleanNote : ''}.`);
    }
    return { created: targets.length };
  }

  // ---------- notifications ----------
  app.get('/notifications', auth, h(async (req, res) => {
    const r = await q('SELECT id, title, body, read, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.uid]);
    res.json(r.rows.map((n) => ({ id: n.id, title: n.title, body: n.body, read: n.read, at: n.created_at })));
  }));

  app.post('/notifications/read', auth, h(async (req, res) => {
    await q('UPDATE notifications SET read=true WHERE user_id=$1 AND read=false', [req.uid]);
    res.json({ ok: true });
  }));

  // ---------- money requests and split bills ----------
  app.get('/requests', auth, h(async (req, res) => {
    const r = await q(
      `SELECT r.id, r.amount, r.note, r.status, r.created_at, r.from_user, r.to_user,
         f.full_name AS from_name, t.full_name AS to_name, f.account_number AS from_account, t.account_number AS to_account
       FROM money_requests r JOIN users f ON f.id = r.from_user JOIN users t ON t.id = r.to_user
       WHERE r.from_user=$1 OR r.to_user=$1 ORDER BY r.id DESC LIMIT 50`, [req.uid]);
    res.json(r.rows.map((x) => ({
      id: x.id,
      amountKobo: Number(x.amount),
      note: x.note,
      status: x.status,
      at: x.created_at,
      // 'payer' = someone asked you to pay them. 'requester' = you asked someone else.
      role: x.to_user === req.uid ? 'payer' : 'requester',
      otherName: maskName(x.to_user === req.uid ? x.from_name : x.to_name),
      otherAccount: x.to_user === req.uid ? x.from_account : x.to_account,
    })));
  }));

  app.post('/requests', auth, h(async (req, res) => {
    await requireEmailVerified(req.uid);
    const { toAccount, amount, note } = req.body || {};
    res.status(201).json(await createRequests(req.uid, [toAccount], Number(amount), note));
  }));

  // totalKobo is the whole bill. Each person, including you, pays an equal share.
  app.post('/requests/split', auth, h(async (req, res) => {
    await requireEmailVerified(req.uid);
    const { accounts, totalKobo, note } = req.body || {};
    if (!Array.isArray(accounts) || !accounts.length) throw httpErr(400, 'Add at least one wallet number');
    const share = Math.floor(Number(totalKobo) / (accounts.length + 1));
    res.status(201).json(await createRequests(req.uid, accounts, share, note));
  }));

  app.post('/requests/:id/decline', auth, h(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Request not found');
    const r = await q(
      `UPDATE money_requests SET status='declined' WHERE id=$1 AND to_user=$2 AND status='pending' RETURNING from_user`,
      [req.params.id, req.uid]);
    if (!r.rowCount) throw httpErr(404, 'Request not found');
    notifyUser(r.rows[0].from_user, 'Request declined', 'Your payment request was declined.');
    res.json({ ok: true });
  }));

  // ---------- bill reminders ----------
  app.get('/reminders', auth, h(async (req, res) => {
    const r = await q(
      `SELECT id, title, amount, to_char(due_date,'YYYY-MM-DD') AS due FROM reminders WHERE user_id=$1 ORDER BY due_date LIMIT 100`, [req.uid]);
    res.json(r.rows.map((x) => ({ id: x.id, title: x.title, amountKobo: Number(x.amount), due: x.due })));
  }));

  app.post('/reminders', auth, h(async (req, res) => {
    const title = String(req.body?.title || '').trim().slice(0, 60);
    const amount = Number(req.body?.amountKobo || 0);
    const due = String(req.body?.due || '');
    if (title.length < 2) throw httpErr(400, 'Give your reminder a name');
    if (!DATE_RE.test(due)) throw httpErr(400, 'Pick a due date');
    if (!Number.isInteger(amount) || amount < 0 || amount > 500_000_000) throw httpErr(400, 'Invalid amount');
    await q('INSERT INTO reminders(user_id, title, amount, due_date) VALUES($1,$2,$3,$4)', [req.uid, title, amount, due]);
    res.status(201).json({ ok: true });
  }));

  app.delete('/reminders/:id', auth, h(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Not found');
    await q('DELETE FROM reminders WHERE id=$1 AND user_id=$2', [req.params.id, req.uid]);
    res.json({ ok: true });
  }));

  // ---------- daily check-in with streak bonus (N10 per day of streak, up to N70) ----------
  app.get('/checkin', auth, h(async (req, res) => {
    const today = (await q('SELECT CURRENT_DATE::text AS d')).rows[0].d;
    const last = (await q('SELECT day::text AS day, streak FROM checkins WHERE user_id=$1 ORDER BY day DESC LIMIT 1', [req.uid])).rows[0];
    const yesterday = (await q(`SELECT (CURRENT_DATE - 1)::text AS d`)).rows[0].d;
    const doneToday = last?.day === today;
    const streak = doneToday ? last.streak : (last?.day === yesterday ? last.streak : 0);
    res.json({ streak, doneToday, nextBonusKobo: 1000 * Math.min(streak + 1, 7) });
  }));

  app.post('/checkin', auth, h(async (req, res) => {
    await requireEmailVerified(req.uid);
    const today = (await q('SELECT CURRENT_DATE::text AS d')).rows[0].d;
    const yesterday = (await q(`SELECT (CURRENT_DATE - 1)::text AS d`)).rows[0].d;
    const last = (await q('SELECT day::text AS day, streak FROM checkins WHERE user_id=$1 ORDER BY day DESC LIMIT 1', [req.uid])).rows[0];
    if (last?.day === today) throw httpErr(409, 'You have already checked in today');
    const streak = last?.day === yesterday ? last.streak + 1 : 1;
    const bonus = 1000 * Math.min(streak, 7);
    await tx(async (c) => {
      await c.query('INSERT INTO checkins(user_id, day, streak) VALUES($1,$2,$3)', [req.uid, today, streak]);
      await post(c, {
        idem: `checkin:${req.uid}:${today}`, kind: 'bonus', userId: req.uid, meta: { type: 'check-in', streak },
        legs: [{ account: 'sys:pool', amount: -bonus }, { account: `u:${req.uid}:main`, amount: bonus }],
      });
    });
    res.json({ streak, bonusKobo: bonus });
  }));

  // ---------- insights and budgets (last 30 days) ----------
  app.get('/insights', auth, h(async (req, res) => {
    const spent = (await q(
      `SELECT j.kind, SUM(-e.amount) AS spent FROM entries e
       JOIN accounts a ON a.id = e.account_id JOIN journal j ON j.id = e.journal_id
       WHERE a.user_id=$1 AND a.kind='main' AND e.amount<0 AND j.created_at >= now() - interval '30 days'
       GROUP BY j.kind`, [req.uid])).rows;
    const income = (await q(
      `SELECT COALESCE(SUM(e.amount),0) AS v FROM entries e
       JOIN accounts a ON a.id = e.account_id JOIN journal j ON j.id = e.journal_id
       WHERE a.user_id=$1 AND a.kind='main' AND e.amount>0 AND j.created_at >= now() - interval '30 days'`, [req.uid])).rows[0].v;
    const budgets = (await q('SELECT category, limit_kobo FROM budgets WHERE user_id=$1 ORDER BY category', [req.uid])).rows;
    const spentBy = Object.fromEntries(spent.map((r) => [r.kind, Number(r.spent)]));
    res.json({
      spent: spent.map((r) => ({ kind: r.kind, spentKobo: Number(r.spent) })),
      incomeKobo: Number(income),
      budgets: budgets.map((b) => ({ category: b.category, limitKobo: Number(b.limit_kobo), spentKobo: spentBy[b.category] || 0 })),
    });
  }));

  app.post('/budgets', auth, h(async (req, res) => {
    const category = String(req.body?.category || '');
    const limit = Number(req.body?.limitKobo);
    if (!BUDGET_CATEGORIES.includes(category)) throw httpErr(400, 'Pick a valid category');
    if (!Number.isInteger(limit) || limit < 1000 || limit > 500_000_000) throw httpErr(400, 'Limit must be between ₦10 and ₦5,000,000');
    await q(
      `INSERT INTO budgets(user_id, category, limit_kobo) VALUES($1,$2,$3)
       ON CONFLICT (user_id, category) DO UPDATE SET limit_kobo=$3`, [req.uid, category, limit]);
    res.json({ ok: true });
  }));

  app.delete('/budgets/:category', auth, h(async (req, res) => {
    await q('DELETE FROM budgets WHERE user_id=$1 AND category=$2', [req.uid, req.params.category]);
    res.json({ ok: true });
  }));

  // ---------- scheduled transfers and savings ----------
  app.get('/schedules', auth, h(async (req, res) => {
    const r = await q(
      `SELECT id, kind, label, amount, frequency, to_account, goal_id, to_char(next_run,'YYYY-MM-DD') AS next
       FROM schedules WHERE user_id=$1 AND active ORDER BY id`, [req.uid]);
    res.json(r.rows.map((s) => ({
      id: s.id, kind: s.kind, label: s.label, amountKobo: Number(s.amount), frequency: s.frequency,
      toAccount: s.to_account, goalId: s.goal_id, next: s.next,
    })));
  }));

  app.post('/schedules', auth, h(async (req, res) => {
    await requireEmailVerified(req.uid);
    const { kind, label, amount, frequency, toAccount, goalId, pin } = req.body || {};
    if (!['transfer', 'save'].includes(kind) || !['weekly', 'monthly'].includes(frequency) || !validAmount(amount)) {
      throw httpErr(400, 'Invalid request');
    }
    const name = String(label || '').trim().slice(0, 40) || (kind === 'save' ? 'Savings' : 'Transfer');
    await checkPin(req.uid, pin, req.body?.approval);
    const firstRun = `now() + CASE WHEN $1='weekly' THEN interval '7 days' ELSE interval '1 month' END`;
    if (kind === 'transfer') {
      const to = (await q('SELECT id FROM users WHERE account_number=$1', [String(toAccount || '')])).rows[0];
      if (!to || to.id === req.uid) throw httpErr(400, 'Invalid recipient');
      await q(
        `INSERT INTO schedules(user_id, kind, label, amount, frequency, to_account, next_run)
         VALUES($2,'transfer',$3,$4,$1,$5, ${firstRun.replace('$1', '$1')})`,
        [frequency, req.uid, name, amount, String(toAccount)]);
    } else {
      const g = (await q('SELECT id FROM goals WHERE id=$1 AND user_id=$2', [Number(goalId), req.uid])).rows[0];
      if (!g) throw httpErr(404, 'Goal not found');
      await q(
        `INSERT INTO schedules(user_id, kind, label, amount, frequency, goal_id, next_run)
         VALUES($2,'save',$3,$4,$1,$5, ${firstRun})`,
        [frequency, req.uid, name, amount, g.id]);
    }
    res.status(201).json({ ok: true });
  }));

  app.delete('/schedules/:id', auth, h(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Not found');
    await q('UPDATE schedules SET active=false WHERE id=$1 AND user_id=$2', [req.params.id, req.uid]);
    res.json({ ok: true });
  }));

  // Runs due schedules. Each run has a fixed idempotency key, so a retry never pays twice.
  async function runSchedules() {
    const due = (await q(
      `SELECT id, user_id, kind, label, amount, frequency, to_account, goal_id, next_run
       FROM schedules WHERE active AND next_run <= now() ORDER BY id LIMIT 50`)).rows;
    for (const s of due) {
      const tag = `sched:${s.id}:${new Date(s.next_run).getTime()}`;
      const amount = Number(s.amount);
      try {
        if (s.kind === 'transfer') {
          const to = (await q('SELECT id FROM users WHERE account_number=$1', [s.to_account])).rows[0];
          if (!to) throw new Error('recipient not found');
          await tx(async (c) => {
            await post(c, {
              idem: `it:${s.user_id}:${tag}`, kind: 'internal_transfer', userId: s.user_id,
              meta: { amount, to: to.id, scheduled: s.id },
              legs: [{ account: `u:${s.user_id}:main`, amount: -amount }, { account: `u:${to.id}:main`, amount }],
            });
          });
        } else {
          const g = (await q('SELECT account_code FROM goals WHERE id=$1', [s.goal_id])).rows[0];
          if (!g) throw new Error('goal not found');
          await tx(async (c) => {
            await post(c, {
              idem: `goal:${s.user_id}:${tag}`, kind: 'goal_deposit', userId: s.user_id,
              meta: { amount, scheduled: s.id },
              legs: [{ account: `u:${s.user_id}:main`, amount: -amount }, { account: g.account_code, amount }],
            });
          });
        }
        notifyUser(s.user_id, 'Scheduled payment done', `${s.label}: ${naira(amount)} was processed.`);
      } catch (e) {
        notifyUser(s.user_id, 'Scheduled payment failed', `${s.label} (${naira(amount)}) could not be paid. Check your balance.`);
        console.error('schedule failed', s.id, e.message);
      }
      await q(
        `UPDATE schedules SET next_run = next_run + CASE WHEN frequency='weekly' THEN interval '7 days' ELSE interval '1 month' END
         WHERE id=$1`, [s.id]);
    }
  }
  if (process.env.RUN_SCHEDULES !== '0') {
    setInterval(() => runSchedules().catch((e) => console.error('schedules tick failed', e.message)), 60_000);
  }

  // ---------- limits, recents, leaderboard, settings ----------
  app.get('/limits', auth, h(async (req, res) => {
    const s = await settings();
    const verified = (await q('SELECT kyc_verified FROM users WHERE id=$1', [req.uid])).rows[0]?.kyc_verified === true;
    const used = Number((await q(
      `SELECT COALESCE(SUM((meta->>'amount')::bigint),0) AS t FROM journal
       WHERE user_id=$1 AND kind IN ('internal_transfer','bank_transfer') AND created_at >= date_trunc('day', now())`,
      [req.uid])).rows[0].t);
    res.json({ verified, limitKobo: verified ? s.daily_limit_verified : s.daily_limit_unverified, usedKobo: used });
  }));

  app.get('/recents', auth, h(async (req, res) => {
    const wallets = (await q(
      `SELECT * FROM (SELECT DISTINCT ON (u.id) u.full_name, u.account_number, j.created_at
         FROM journal j JOIN users u ON u.id = (j.meta->>'to')::uuid
         WHERE j.user_id=$1 AND j.kind='internal_transfer'
         ORDER BY u.id, j.created_at DESC) x ORDER BY created_at DESC LIMIT 5`, [req.uid])).rows;
    const banks = (await q(
      `SELECT * FROM (SELECT DISTINCT ON (j.meta->>'accountNumber') j.meta->>'accountNumber' AS account_number,
           j.meta->>'bankCode' AS bank_code, j.created_at
         FROM journal j WHERE j.user_id=$1 AND j.kind='bank_transfer'
         ORDER BY j.meta->>'accountNumber', j.created_at DESC) x ORDER BY created_at DESC LIMIT 5`, [req.uid])).rows;
    res.json({
      wallets: wallets.map((w) => ({ name: maskName(w.full_name), accountNumber: w.account_number })),
      banks: banks.map((b) => ({ accountNumber: b.account_number, bankCode: b.bank_code })),
    });
  }));

  app.get('/leaderboard', auth, h(async (req, res) => {
    const top = (await q(
      `SELECT u.id, u.full_name, COUNT(r.id) AS n FROM users r JOIN users u ON u.id = r.referred_by
       WHERE r.created_at >= date_trunc('month', now())
       GROUP BY u.id, u.full_name ORDER BY n DESC LIMIT 10`)).rows;
    res.json(top.map((x, i) => ({ rank: i + 1, name: maskName(x.full_name), friends: Number(x.n), me: x.id === req.uid })));
  }));

  app.get('/me/settings', auth, h(async (req, res) => {
    const g = (await q('SELECT roundup_goal FROM users WHERE id=$1', [req.uid])).rows[0];
    res.json({ roundupGoalId: g?.roundup_goal ? Number(g.roundup_goal) : null });
  }));

  // Round-up: every transfer rounds up to the next ₦100, and the difference goes to this goal.
  app.patch('/me/roundup', auth, h(async (req, res) => {
    const goalId = req.body?.goalId;
    if (goalId === null || goalId === undefined || goalId === '') {
      await q('UPDATE users SET roundup_goal=NULL WHERE id=$1', [req.uid]);
    } else {
      const g = (await q('SELECT id FROM goals WHERE id=$1 AND user_id=$2', [Number(goalId), req.uid])).rows[0];
      if (!g) throw httpErr(404, 'Goal not found');
      await q('UPDATE users SET roundup_goal=$2 WHERE id=$1', [req.uid, g.id]);
    }
    res.json({ ok: true });
  }));
}

// Exported for server.js: the round-up applied after each successful transfer.
export async function applyRoundUp({ q, tx, uid, amount, idem }) {
  const g = (await q(
    'SELECT g.id, g.account_code FROM users u JOIN goals g ON g.id = u.roundup_goal AND g.user_id = u.id WHERE u.id=$1', [uid])).rows[0];
  if (!g) return;
  const extra = (10000 - (Number(amount) % 10000)) % 10000;
  if (extra <= 0) return;
  await tx(async (c) => post(c, {
    idem: `roundup:${idem}`, kind: 'goal_deposit', userId: uid, meta: { amount: extra, goal: Number(g.id), roundup: true },
    legs: [{ account: `u:${uid}:main`, amount: -extra }, { account: g.account_code, amount: extra }],
  })).catch((e) => console.error('roundup skipped', e.message));
}
