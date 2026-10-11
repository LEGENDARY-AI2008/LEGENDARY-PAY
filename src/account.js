// Delete my account. Personal details are wiped and sign-in is blocked, but the money records stay
// (the ledger must stay complete for audits and disputes). Only allowed when the wallet is empty.
export function mountAccount(app, d) {
  const { auth, h, q, tx, httpErr, checkPin } = d;

  // DELETE /me/account  { pin | approval, confirm: "DELETE" }
  app.delete('/me/account', auth, h(async (req, res) => {
    const body = req.body || {};
    if (String(body.confirm || '').trim() !== 'DELETE') throw httpErr(400, 'Type DELETE to confirm');
    await checkPin(req.uid, body.pin, body.approval);

    const left = (await q(
      `SELECT COALESCE(SUM(balance),0) AS total FROM accounts WHERE code LIKE $1`, [`u:${req.uid}:%`])).rows[0].total;
    if (Number(left) !== 0) throw httpErr(409, 'Move or withdraw all your money first, then try again');

    await tx(async (c) => {
      await c.query(
        `UPDATE users SET phone = $2, email = NULL, pin_hash = '!deleted', pin_fails = 0, locked_until = NULL,
           device_id = NULL, account_number = NULL, deleted_at = now()
         WHERE id = $1`, [req.uid, `deleted-${req.uid}`]);
      await c.query(`UPDATE support_threads SET status = 'closed' WHERE user_id = $1`, [req.uid]);
    });
    res.json({ ok: true });
  }));
}
