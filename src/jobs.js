import { q } from './db.js';
import { alert } from './alert.js';

export async function enqueue(c, type, payload = {}, { dedupe = null, delaySec = 0 } = {}) {
  const run = c ? c.query.bind(c) : q;
  await run(
    `INSERT INTO jobs(type, payload, dedupe, run_at) VALUES($1,$2,$3, now() + make_interval(secs => $4))
     ON CONFLICT (dedupe) DO NOTHING`,
    [type, payload, dedupe, delaySec]
  );
}

// handlers: { type: { run(payload, job), onDead?(payload, job) } }
export function startWorker(handlers) {
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await q(`UPDATE jobs SET status='queued' WHERE status='running' AND locked_at < now() - interval '5 minutes'`);
      for (;;) {
        const r = await q(
          `UPDATE jobs SET status='running', attempts=attempts+1, locked_at=now()
           WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_at <= now()
                       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
        );
        const job = r.rows[0];
        if (!job) break;
        const h = handlers[job.type];
        try {
          if (!h) throw new Error('no handler for ' + job.type);
          await h.run(job.payload, job);
          await q(`UPDATE jobs SET status='done' WHERE id=$1`, [job.id]);
        } catch (e) {
          const dead = job.attempts >= 5;
          await q(
            `UPDATE jobs SET status=$2, last_error=$3, run_at = now() + make_interval(secs => $4) WHERE id=$1`,
            [job.id, dead ? 'failed' : 'queued', String(e.message).slice(0, 500), job.attempts ** 2 * 30]
          );
          if (dead) {
            await alert(`job ${job.id} (${job.type}) failed permanently: ${e.message}`);
            try { await h?.onDead?.(job.payload, job); } catch (x) { await alert('onDead error: ' + x.message); }
          }
        }
      }
    } catch (e) {
      console.error('worker tick error', e);
    } finally {
      busy = false;
    }
  }
  setInterval(tick, 2000);
  tick();
}
