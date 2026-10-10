import { tx } from './db.js';
import { post } from './ledger.js';
import { alert } from './alert.js';

// Final outcome of a bank payout: 'success' just records it; 'failed' refunds the user in full.
export async function settlePayout(payoutId, outcome) {
  let refunded = false;
  await tx(async (c) => {
    const p = (await c.query('SELECT * FROM payouts WHERE id=$1 FOR UPDATE', [payoutId])).rows[0];
    if (!p || !['queued', 'processing'].includes(p.status)) return;
    if (outcome === 'success') {
      await c.query(`UPDATE payouts SET status='success' WHERE id=$1`, [p.id]);
      return;
    }
    const A = Number(p.amount), F = Number(p.fee), PF = Number(p.partner_fee), PP = Number(p.pool_part), RV = Number(p.rev_part);
    await post(c, {
      idem: `refund:${p.id}`, kind: 'refund', userId: p.user_id,
      legs: [
        { account: 'sys:external', amount: -(A + PF) },
        { account: 'sys:revenue', amount: -RV },
        { account: 'sys:pool', amount: -PP },
        { account: `u:${p.user_id}:main`, amount: A + F },
      ],
    });
    await c.query(`UPDATE payouts SET status='refunded' WHERE id=$1`, [p.id]);
    await c.query(`UPDATE bonus_grants SET status='void' WHERE user_id=$1 AND type='cashback' AND ref=$2 AND status='pending'`, [p.user_id, p.idem]);
    refunded = true;
  });
  if (refunded) await alert(`payout ${payoutId} failed, user refunded`);
}
