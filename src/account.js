// Delete my account, and export my data (NDPA right of access and deletion).
// Personal details and saved items are wiped and sign-in is blocked. Money records stay
// (the ledger must stay complete for audits and disputes). Only allowed when the wallet is empty.
export function mountAccount(app, d) {
  const { auth, h, q, tx, httpErr, checkPin } = d;

  // GET /me/data: everything we hold about the signed-in user, as a JSON file.
  app.get('/me/data', auth, h(async (req, res) => {
    const uid = req.uid;
    const [profile, beneficiaries, payouts, bills, ledger, support] = await Promise.all([
      q(`SELECT phone, email, full_name, account_number, virtual_account, virtual_bank, kyc_verified, email_verified, created_at
         FROM users WHERE id=$1`, [uid]),
      q(`SELECT type, label, account_number, bank_code FROM beneficiaries WHERE user_id=$1`, [uid]),
      q(`SELECT amount, fee, bank_code, account_number, status, created_at FROM payouts WHERE user_id=$1 ORDER BY created_at`, [uid]),
      q(`SELECT network, phone, amount, status, created_at FROM bill_payments WHERE user_id=$1 ORDER BY created_at`, [uid]),
      q(`SELECT j.kind, j.created_at, e.amount FROM entries e
         JOIN journal j ON j.id = e.journal_id JOIN accounts a ON a.id = e.account_id
         WHERE a.user_id=$1 ORDER BY j.created_at`, [uid]),
      q(`SELECT m.sender, m.body, m.created_at FROM support_messages m
         JOIN support_threads t ON t.id = m.thread_id WHERE t.user_id=$1 ORDER BY m.created_at`, [uid]),
    ]);
    res.set('Content-Disposition', 'attachment; filename="legendary-pay-my-data.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      profile: profile.rows[0] || null,
      savedBeneficiaries: beneficiaries.rows,
      payouts: payouts.rows,
      billPayments: bills.rows,
      transactions: ledger.rows,
      supportMessages: support.rows,
    });
  }));

  // DELETE /me/account  { pin | approval, confirm: "DELETE" }
  app.delete('/me/account', auth, h(async (req, res) => {
    const body = req.body || {};
    if (String(body.confirm || '').trim() !== 'DELETE') throw httpErr(400, 'Type DELETE to confirm');
    await checkPin(req.uid, body.pin, body.approval);

    const left = (await q(
      `SELECT COALESCE(SUM(balance),0) AS total FROM accounts WHERE code LIKE $1`, [`u:${req.uid}:%`])).rows[0].total;
    if (Number(left) !== 0) throw httpErr(409, 'Move or withdraw all your money first, then try again');

    await tx(async (c) => {
      // Saved items and devices go. Money records stay.
      for (const t of ['beneficiaries', 'reminders', 'schedules', 'bill_schedules', 'budgets',
        'notifications', 'checkins', 'push_subscriptions', 'webauthn_credentials', 'webauthn_challenges']) {
        await c.query(`DELETE FROM ${t} WHERE user_id = $1`, [req.uid]);
      }
      await c.query(`UPDATE bill_payments SET phone = 'deleted' WHERE user_id = $1`, [req.uid]);
      await c.query(
        `UPDATE users SET phone = $2, email = NULL, full_name = NULL, pin_hash = '!deleted', pin_fails = 0, locked_until = NULL,
           device_id = NULL, account_number = NULL, virtual_account = NULL, virtual_bank = NULL, deleted_at = now()
         WHERE id = $1`, [req.uid, `deleted-${req.uid}`]);
      await c.query(`UPDATE support_threads SET status = 'closed' WHERE user_id = $1`, [req.uid]);
    });
    res.json({ ok: true });
  }));
}
