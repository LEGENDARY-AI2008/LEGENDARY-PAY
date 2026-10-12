import 'dotenv/config';
import { startWorker, enqueue } from './jobs.js';
import { releasePending, evaluateUser, unlockBonus } from './bonus.js';
import { q, tx } from './db.js';
import { post } from './ledger.js';
import { runDueBills } from './bills.js';
import { payout, payoutStatus } from './flutterwave.js';
import { settlePayout } from './payouts.js';
import { alert } from './alert.js';
import { sendMail } from './mail.js';
import { pushAll } from './push.js';

const ref = (id) => `payout-${id}`;

startWorker({
  evaluate_bonuses: { run: async ({ userId }) => { await evaluateUser(userId); await releasePending(); await unlockBonus(userId); } },
  release_pending: { run: releasePending },
  push_all: { run: (payload) => pushAll(payload) },
  run_bill_schedules: { run: () => runDueBills({ q, tx, post, alert, httpErr: (status, msg) => Object.assign(new Error(msg), { status }) }) },
  send_mail: { run: ({ to, subject, text }) => sendMail(to, subject, text) },
  payout: {
    run: async ({ payoutId }) => {
      const p = (await q('SELECT * FROM payouts WHERE id=$1', [payoutId])).rows[0];
      if (!p || p.status !== 'queued') return;
      const r = await payout(p);
      if (r.status === 'success') await settlePayout(p.id, 'success');
      else if (r.status === 'failed') await settlePayout(p.id, 'failed');
      else await q(`UPDATE payouts SET status='processing' WHERE id=$1 AND status='queued'`, [p.id]);
    },
    // After 5 failed attempts: only refund if the partner confirms it never went through.
    onDead: async ({ payoutId }) => {
      const st = await payoutStatus(ref(payoutId)).catch(() => null);
      if (st === 'success') await settlePayout(payoutId, 'success');
      else if (st === 'failed' || st === 'not_found') await settlePayout(payoutId, 'failed');
      else await alert(`payout ${payoutId} needs a manual check (partner status unknown)`);
    },
  },
  payout_check: {
    run: async () => {
      const r = await q(`SELECT id FROM payouts WHERE status='processing' AND created_at < now() - interval '2 minutes' LIMIT 50`);
      for (const { id } of r.rows) {
        const st = await payoutStatus(ref(id));
        if (st === 'success' || st === 'failed') await settlePayout(id, st);
      }
    },
  },
  integrity: {
    run: async () => {
      const r = await q('SELECT COALESCE(SUM(balance),0) AS t FROM accounts');
      if (Number(r.rows[0].t) !== 0) await alert(`LEDGER IMBALANCE: ${r.rows[0].t}`);
    },
  },
});

// recurring jobs, deduped per time bucket so several instances never double-schedule
setInterval(() => {
  const now = Date.now(), min = Math.floor(now / 60000);
  enqueue(null, 'release_pending', {}, { dedupe: `release:${min}` });
  enqueue(null, 'payout_check', {}, { dedupe: `pcheck:${Math.floor(now / 300000)}` });
  if (min % 60 === 0) enqueue(null, 'integrity', {}, { dedupe: `integrity:${min}` });
  enqueue(null, 'run_bill_schedules', {}, { dedupe: `bills:${Math.floor(now / 3600000)}` });
}, 30000);
console.log('worker running');
