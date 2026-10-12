// Data bundles, electricity and cable TV bills. Same safety rules as airtime:
// the PIN or fingerprint is checked first, money is taken in the same step as the record,
// a confirmed failure refunds, and an unknown outcome never refunds automatically.
// Repeating bills (bill_schedules) are paid by the worker through the same function.
import { listBillers, listBillerItems, validateBillCustomer, payBillItem } from './flutterwave.js';
import { pushUsers } from './push.js';
import { settings } from './db.js';
import { queueGrant } from './bonus.js';
import { enqueue } from './jobs.js';

const CATEGORIES = ['DATA', 'ELECTRICITY', 'CABLE', 'EXAM', 'INTERNET', 'BETTING', 'WATER', 'INSURANCE', 'WASTE', 'SCHOOL'];
const KIND = {
  DATA: 'bill_data', ELECTRICITY: 'bill_electricity', CABLE: 'bill_cable',
  EXAM: 'bill_exam', INTERNET: 'bill_internet', BETTING: 'bill_betting',
  WATER: 'bill_water', INSURANCE: 'bill_insurance', WASTE: 'bill_waste', SCHOOL: 'bill_school',
};
const LABEL = {
  DATA: 'Data bundle', ELECTRICITY: 'Electricity bill', CABLE: 'Cable TV',
  EXAM: 'Exam PIN', INTERNET: 'Internet plan', BETTING: 'Betting top-up',
  WATER: 'Water bill', INSURANCE: 'Insurance premium', WASTE: 'Waste bill', SCHOOL: 'School fees',
};
const CODE_RE = /^[A-Za-z0-9_-]{1,60}$/;
const MAX_SCHEDULES = 10;
// Our service fee: 3% of the price, added to the total the user pays. It goes to sys:revenue (our profit).
// Change FEE_RATE here and redeploy. Keep it in step with FEE_RATE in the web bills.js.
export const FEE_RATE_BPS = 300; // 300 basis points = 3%
export function billFeeKobo(amountKobo) {
  return Math.round((Number(amountKobo) * FEE_RATE_BPS) / 10000);
}
// Services where the user types the amount (the rest have a fixed price from the provider).
export const TYPED_AMOUNT = ['ELECTRICITY', 'BETTING', 'WATER', 'INSURANCE', 'WASTE', 'SCHOOL'];

const validAmount = (n) => Number.isInteger(n) && n >= 1000 && n <= 50_000_000; // ₦10 .. ₦500,000 in kobo

// Phone for data; meter or smartcard digits for electricity and cable; an account or registration code for the rest.
function customerOk(category, customer) {
  if (category === 'DATA') return /^0\d{10}$/.test(customer);
  if (category === 'ELECTRICITY' || category === 'CABLE') return /^\d{8,13}$/.test(customer);
  return /^[A-Za-z0-9\/-]{4,20}$/.test(customer);
}

// Pays one bill. Used by the pay button (after PIN check) and by repeating bills (worker).
// d = { q, tx, post, alert, httpErr }. input = { category, biller, item, customer, amount (kobo), idemKey }.
export async function payBillFor(d, uid, input) {
  const { q, tx, post, alert, httpErr } = d;
  const category = CATEGORIES.includes(input.category) ? input.category : null;
  if (!category) throw httpErr(400, 'Pick a bill type');
  if (!CODE_RE.test(String(input.biller || ''))) throw httpErr(400, 'Pick a provider');
  if (!CODE_RE.test(String(input.item || ''))) throw httpErr(400, 'Pick a plan');
  const biller = String(input.biller);
  const item = String(input.item);
  const customer = String(input.customer || '').trim();
  if (!customerOk(category, customer) || !input.idemKey) throw httpErr(400, 'Invalid request');

  // The price comes from the provider's plan list, never from the app, so it cannot be changed on the way.
  const plan = (await listBillerItems(biller, category)).find((i) => i.code === item);
  if (!plan) throw httpErr(400, 'That plan is no longer available');
  const amount = plan.amountKobo > 0 ? plan.amountKobo : Number(input.amount);
  if (!validAmount(amount)) throw httpErr(400, 'Enter an amount between ₦10 and ₦500,000');
  const fee = billFeeKobo(amount);
  const total = amount + fee;

  const reference = `bill-${category.toLowerCase()}-${uid}-${input.idemKey}`;
  const existing = (await q('SELECT status FROM bill_payments WHERE reference=$1', [reference])).rows[0];
  if (existing) {
    if (existing.status === 'failed') throw httpErr(502, `${LABEL[category]} could not be paid. Your money has been returned to your wallet. Try again.`);
    return { status: existing.status, reference, planName: plan.name, category };
  }

  // Take the money first, together with the record. Insufficient balance rolls it all back.
  await tx(async (c) => {
    // bill_payments keeps the provider code in "network" and the meter/phone/card number in "phone".
    await c.query(
      `INSERT INTO bill_payments(user_id, reference, network, phone, amount) VALUES($1,$2,$3,$4,$5)`,
      [uid, reference, biller, customer, amount]);
    await post(c, {
      idem: `bill:${reference}`, kind: KIND[category], userId: uid,
      meta: { amount, fee, category, biller, item: plan.name, customer, reference },
      legs: [
        { account: `u:${uid}:main`, amount: -total },
        { account: 'sys:external', amount },
        { account: 'sys:revenue', amount: fee },
      ],
    });
  });

  let result;
  try {
    result = await payBillItem({ reference, category, billerCode: biller, itemCode: item, customer, amountKobo: amount });
  } catch (e) {
    // Unknown outcome: do NOT refund automatically, the provider may have accepted it.
    result = { status: 'pending', msg: e.message };
    await alert(`${category} bill outcome unknown, ref ${reference}: ${e.message}`);
  }

  if (result.status === 'failed') {
    await tx(async (c) => {
      await post(c, {
        idem: `billrefund:${reference}`, kind: 'refund', userId: uid, meta: { reference },
        legs: [
          { account: `u:${uid}:main`, amount: total },
          { account: 'sys:external', amount: -amount },
          { account: 'sys:revenue', amount: -fee },
        ],
      });
      await c.query(`UPDATE bill_payments SET status='failed', error=$2 WHERE reference=$1`, [reference, result.msg || 'failed']);
    });
    throw httpErr(502, `${LABEL[category]} could not be paid. Your money has been returned to your wallet. Try again.`);
  }
  await q('UPDATE bill_payments SET status=$2, error=$3 WHERE reference=$1', [reference, result.status, result.msg || null]);

  // Cashback: a share of the BILL AMOUNT goes back to the user (bonus, unlocks with normal rules).
  // Setting bill_cashback_bps: 200 = ₦2 per ₦100. Our fee is ₦3 per ₦100, so we keep ₦1. Change it in admin settings.
  const s = await settings();
  const rate = Number(s.bill_cashback_bps ?? 200);
  await tx((c) => queueGrant(c, uid, 'cashback', `bill:${reference}`, Math.floor((amount * rate) / 10000)));
  await enqueue(null, 'evaluate_bonuses', { userId: uid });
  return { status: result.status, reference, planName: plan.name, category, amount };
}

// Worker job: pays every repeating bill that is due. The schedule moves to its next date first,
// so one run can never be paid twice. Each run has its own reference, so a retry cannot double-charge.
export async function runDueBills(d) {
  const { q } = d;
  const due = (await q(`SELECT * FROM bill_schedules WHERE active = true AND next_run <= now() ORDER BY id LIMIT 50`)).rows;
  for (const s of due) {
    const next = new Date(Date.now() + Number(s.every_days) * 86400000);
    const moved = await q(
      `UPDATE bill_schedules SET next_run=$2 WHERE id=$1 AND next_run=$3 AND active = true RETURNING id`,
      [s.id, next, s.next_run]);
    if (!moved.rows[0]) continue;
    const label = s.plan_name || LABEL[s.category] || 'Bill';
    try {
      const r = await payBillFor(d, s.user_id, {
        category: s.category, biller: s.biller, item: s.item, customer: s.customer,
        amount: s.amount_kobo ? Number(s.amount_kobo) : undefined,
        idemKey: `sched${s.id}-${new Date(s.next_run).getTime()}`,
      });
      await notifyUser(q, pushUsers, s.user_id, 'Repeat bill paid', `${label} for ${s.customer} was paid from your wallet.`);
    } catch (e) {
      await notifyUser(q, pushUsers, s.user_id, 'Repeat bill not paid',
        `${label} for ${s.customer} was not paid: ${e.message}. We will try again on the next date.`);
    }
  }
}

async function notifyUser(q, pushFn, userId, title, body) {
  await q('INSERT INTO notifications(user_id, title, body) VALUES($1,$2,$3)', [userId, title, body]).catch(() => {});
  pushFn([userId], { title, body: body.slice(0, 140) }).catch(() => {});
}

export function mountBills(app, d) {
  const { auth, h, q, tx, post, httpErr, alert, checkPin, requireEmailVerified } = d;
  const deps = { q, tx, post, alert, httpErr };

  const cat = (v) => {
    if (!CATEGORIES.includes(v)) throw httpErr(400, 'Pick a bill type');
    return v;
  };
  const code = (v, what) => {
    if (!CODE_RE.test(String(v || ''))) throw httpErr(400, `Pick a ${what}`);
    return String(v);
  };

  // GET /bills/billers?category=DATA|ELECTRICITY|CABLE
  app.get('/bills/billers', auth, h(async (req, res) => {
    const category = cat(req.query.category);
    res.json(await listBillers(category));
  }));

  // GET /bills/items?category=...&biller=CODE
  app.get('/bills/items', auth, h(async (req, res) => {
    const category = cat(req.query.category);
    const biller = code(req.query.biller, 'provider');
    const items = await listBillerItems(biller, category);
    res.json(items.map((i) => ({ code: i.code, name: i.name, amountKobo: i.amountKobo })));
  }));

  // POST /bills/check  { category, biller, item, customer }  -> { name }
  app.post('/bills/check', auth, h(async (req, res) => {
    await requireEmailVerified(req.uid);
    const category = cat(req.body?.category);
    const biller = code(req.body?.biller, 'provider');
    const item = code(req.body?.item, 'plan');
    const customer = String(req.body?.customer || '').trim();
    if (!customerOk(category, customer)) throw httpErr(400, category === 'DATA' ? 'Enter a valid phone number' : 'Enter a valid number');
    if (category === 'DATA') return res.json({ name: customer });
    res.json(await validateBillCustomer({ billerCode: biller, itemCode: item, customer }));
  }));

  // POST /bills/pay  { category, biller, item, customer, amount (kobo, electricity only), pin|approval, idemKey }
  app.post('/bills/pay', auth, h(async (req, res) => {
    await requireEmailVerified(req.uid);
    const body = req.body || {};
    await checkPin(req.uid, body.pin, body.approval);
    const r = await payBillFor(deps, req.uid, body);
    res.json({ status: r.status, reference: r.reference });
  }));

  // POST /bills/repeat  { same fields as /bills/pay, every: 7 | 30, pin|approval, idemKey }
  // Pays now, then pays again every 7 or 30 days from the wallet.
  app.post('/bills/repeat', auth, h(async (req, res) => {
    await requireEmailVerified(req.uid);
    const body = req.body || {};
    const every = Number(body.every);
    if (![7, 30].includes(every)) throw httpErr(400, 'Pick weekly or monthly');
    await checkPin(req.uid, body.pin, body.approval);
    const active = Number((await q('SELECT COUNT(*) AS n FROM bill_schedules WHERE user_id=$1 AND active = true', [req.uid])).rows[0].n);
    if (active >= MAX_SCHEDULES) throw httpErr(400, `You can have up to ${MAX_SCHEDULES} repeating bills. Cancel one first.`);
    const r = await payBillFor(deps, req.uid, body);
    await q(
      `INSERT INTO bill_schedules(user_id, category, biller, item, plan_name, customer, amount_kobo, every_days, next_run)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $8))`,
      [req.uid, r.category, String(body.biller), String(body.item), r.planName, String(body.customer).trim(),
        Number(body.amount) || null, every]);
    res.json({ status: r.status, reference: r.reference });
  }));

  // GET /bills/schedules  -> the user's active repeating bills
  app.get('/bills/schedules', auth, h(async (req, res) => {
    const rows = (await q(
      `SELECT id, category, plan_name, customer, every_days, next_run FROM bill_schedules
        WHERE user_id=$1 AND active = true ORDER BY next_run`, [req.uid])).rows;
    res.json(rows.map((r) => ({
      id: r.id, category: r.category, plan: r.plan_name, customer: r.customer,
      everyDays: r.every_days, nextRun: r.next_run,
    })));
  }));

  // POST /bills/schedules/:id/cancel
  app.post('/bills/schedules/:id/cancel', auth, h(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Not found');
    await q('UPDATE bill_schedules SET active = false WHERE id=$1 AND user_id=$2', [req.params.id, req.uid]);
    res.json({ ok: true });
  }));
}
