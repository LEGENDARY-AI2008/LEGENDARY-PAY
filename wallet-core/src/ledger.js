// Double-entry ledger. Every posting: legs sum to zero, idempotent by key, balances locked in sorted order.
export const INSUFFICIENT = (e) => e && e.code === '23514'; // CHECK (balance >= 0) violated

export async function post(c, { idem, kind, userId = null, meta = {}, legs }) {
  if (!legs.every((l) => Number.isSafeInteger(l.amount))) throw new Error('non-integer amount');
  if (legs.reduce((s, l) => s + l.amount, 0) !== 0) throw new Error('unbalanced journal');

  const j = await c.query(
    `INSERT INTO journal(idem_key, kind, user_id, meta) VALUES($1,$2,$3,$4)
     ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    [idem, kind, userId, meta]
  );
  if (!j.rowCount) return { duplicate: true };

  const merged = new Map();
  for (const l of legs) merged.set(l.account, (merged.get(l.account) || 0) + l.amount);
  const codes = [...merged.keys()].sort();
  const accs = await c.query(
    'SELECT id, code FROM accounts WHERE code = ANY($1) ORDER BY code FOR UPDATE', [codes]
  );
  if (accs.rowCount !== codes.length) throw new Error('unknown account in journal');

  for (const a of accs.rows) {
    const amt = merged.get(a.code);
    if (amt === 0) continue;
    await c.query('INSERT INTO entries(journal_id, account_id, amount) VALUES($1,$2,$3)', [j.rows[0].id, a.id, amt]);
    await c.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amt, a.id]);
  }
  return { duplicate: false, id: j.rows[0].id };
}
