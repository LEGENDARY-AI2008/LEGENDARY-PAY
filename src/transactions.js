// Transaction features: search and filter a user's money history, and report a problem
// with one transaction (the report goes to the live chat team).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = [
  'deposit', 'internal_transfer', 'bank_transfer', 'refund', 'cashback', 'bonus',
  'referral', 'goal_deposit', 'goal_withdraw', 'bill_airtime', 'bill_data', 'bill_electricity', 'bill_cable',
  'bill_exam', 'bill_internet', 'bill_betting', 'bill_water', 'bill_insurance', 'bill_waste', 'bill_school',
];

export function mountTransactions(app, d) {
  const { auth, h, q, httpErr, naira } = d;

  // GET /transactions?q=&dir=in|out&kind=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=
  app.get('/transactions', auth, h(async (req, res) => {
    const params = [req.uid];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    const where = ['a.user_id = $1', `(a.kind = 'main' OR j.kind = 'bonus')`];

    if (req.query.dir === 'in') where.push('e.amount > 0');
    else if (req.query.dir === 'out') where.push('e.amount < 0');

    if (req.query.kind) {
      const kind = String(req.query.kind);
      if (!KINDS.includes(kind)) throw httpErr(400, 'Unknown transaction type');
      where.push(`j.kind = ${add(kind)}`);
    }
    if (req.query.from) {
      if (!DATE_RE.test(String(req.query.from))) throw httpErr(400, 'Pick a valid start date');
      where.push(`(j.created_at AT TIME ZONE 'Africa/Lagos') >= ${add(String(req.query.from))}::date`);
    }
    if (req.query.to) {
      if (!DATE_RE.test(String(req.query.to))) throw httpErr(400, 'Pick a valid end date');
      where.push(`(j.created_at AT TIME ZONE 'Africa/Lagos') < (${add(String(req.query.to))}::date + 1)`);
    }
    const text = String(req.query.q || '').trim().slice(0, 60);
    if (text) {
      const pattern = add(`%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      const n = Number(text);
      // A number also matches an amount in naira, e.g. 500 finds ₦500.00.
      const byAmount = Number.isInteger(n) && n > 0 ? ` OR ABS(e.amount) = ${add(Math.round(n * 100))}` : '';
      where.push(`(j.meta->>'note' ILIKE ${pattern} OR j.kind ILIKE ${pattern}${byAmount})`);
    }

    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 100, 1), 5000);
    const rows = (await q(
      `SELECT j.id, j.kind, e.amount, j.created_at, j.meta
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
       JOIN journal j ON j.id = e.journal_id
       WHERE ${where.join(' AND ')}
       ORDER BY j.created_at DESC, e.id DESC
       LIMIT ${limit}`, params)).rows;

    res.json(rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountKobo: Number(r.amount),
      at: r.created_at,
      note: r.meta?.note || '',
    })));
  }));

  // POST /transactions/:id/report  { message }
  app.post('/transactions/:id/report', auth, h(async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpErr(404, 'Transaction not found');

    const tx = (await q(
      `SELECT j.kind, j.created_at, e.amount
       FROM journal j
       JOIN entries e ON e.journal_id = j.id
       JOIN accounts a ON a.id = e.account_id
       WHERE j.id = $1 AND a.user_id = $2 AND (a.kind = 'main' OR j.kind = 'bonus')
       LIMIT 1`, [id, req.uid])).rows[0];
    if (!tx) throw httpErr(404, 'Transaction not found');

    const message = String(req.body?.message || '').trim().slice(0, 400);
    if (message.length < 5) throw httpErr(400, 'Tell us what went wrong, in a few words');

    // Stop one user flooding the team: at most 5 reports an hour.
    const recent = (await q(
      `SELECT COUNT(*) AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
       WHERE t.user_id = $1 AND m.body LIKE 'Problem with transaction%' AND m.created_at > now() - interval '1 hour'`,
      [req.uid])).rows[0].n;
    if (Number(recent) >= 5) throw httpErr(429, 'You have sent several reports. Please wait a while.');

    let thread = (await q(
      `SELECT id FROM support_threads WHERE user_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`, [req.uid])).rows[0];
    if (!thread) thread = (await q('INSERT INTO support_threads(user_id) VALUES($1) RETURNING id', [req.uid])).rows[0];

    const when = new Date(tx.created_at).toISOString().slice(0, 10);
    const amount = naira(Math.abs(Number(tx.amount)));
    const body = `Problem with transaction ${tx.kind} of ${amount} on ${when} (ref ${id}): ${message}`.slice(0, 500);
    await q(`INSERT INTO support_messages(thread_id, sender, body) VALUES($1,'user',$2)`, [thread.id, body]);
    await q('UPDATE support_threads SET updated_at=now() WHERE id=$1', [thread.id]);
    res.status(201).json({ ok: true });
  }));
}
