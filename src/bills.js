// Data bundles, electricity and cable TV bills. Same safety rules as airtime:
// the PIN or fingerprint is checked first, money is taken in the same step as the record,
// a confirmed failure refunds, and an unknown outcome never refunds automatically.
import { listBillers, listBillerItems, validateBillCustomer, payBillItem } from './flutterwave.js';

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
// Our service fee per bill, in kobo. It goes to sys:revenue (our profit). Change here and redeploy.
export const BILL_FEE_KOBO = { DATA: 5000, ELECTRICITY: 10000, CABLE: 10000, EXAM: 10000, INTERNET: 10000, BETTING: 5000, WATER: 5000, INSURANCE: 10000, WASTE: 5000, SCHOOL: 10000 };
// Services where the user types the amount (the rest have a fixed price from the provider).
export const TYPED_AMOUNT = ['ELECTRICITY', 'BETTING', 'WATER', 'INSURANCE', 'WASTE', 'SCHOOL'];

export function mountBills(app, d) {
  const { auth, h, q, tx, post, httpErr, alert, checkPin, requireEmailVerified, validAmount } = d;

  const cat = (v) => {
    if (!CATEGORIES.includes(v)) throw httpErr(400, 'Pick a bill type');
    return v;
  };
  const code = (v, what) => {
    if (!CODE_RE.test(String(v || ''))) throw httpErr(400, `Pick a ${what}`);
    return String(v);
  };
  // Phone for data; meter or smartcard digits for electricity and cable; an account or registration code for the rest.
  const customerOk = (category, customer) => {
    if (category === 'DATA') return /^0\d{10}$/.test(customer);
    if (category === 'ELECTRICITY' || category === 'CABLE') return /^\d{8,13}$/.test(customer);
    return /^[A-Za-z0-9\/-]{4,20}$/.test(customer);
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
    const category = cat(body.category);
    const biller = code(body.biller, 'provider');
    const item = code(body.item, 'plan');
    const customer = String(body.customer || '').trim();
    if (!customerOk(category, customer) || !body.idemKey) throw httpErr(400, 'Invalid request');

    // The price comes from the provider's plan list, never from the app, so it cannot be changed on the way.
    const plan = (await listBillerItems(biller, category)).find((i) => i.code === item);
    if (!plan) throw httpErr(400, 'That plan is no longer available');
    const amount = plan.amountKobo > 0 ? plan.amountKobo : Number(body.amount);
    if (!validAmount(amount)) throw httpErr(400, 'Enter an amount between ₦10 and ₦500,000');
    const fee = BILL_FEE_KOBO[category];
    const total = amount + fee;

    await checkPin(req.uid, body.pin, body.approval);
    const reference = `bill-${category.toLowerCase()}-${req.uid}-${body.idemKey}`;
    const existing = (await q('SELECT status FROM bill_payments WHERE reference=$1', [reference])).rows[0];
    if (existing) {
      if (existing.status === 'failed') throw httpErr(502, `${LABEL[category]} could not be paid. Your money has been returned to your wallet. Try again.`);
      return res.json({ status: existing.status, reference });
    }

    // Take the money first, together with the record. Insufficient balance rolls it all back.
    await tx(async (c) => {
      // bill_payments keeps the provider code in "network" and the meter/phone/card number in "phone".
      await c.query(
        `INSERT INTO bill_payments(user_id, reference, network, phone, amount) VALUES($1,$2,$3,$4,$5)`,
        [req.uid, reference, biller, customer, amount]);
      await post(c, {
        idem: `bill:${reference}`, kind: KIND[category], userId: req.uid,
        meta: { amount, fee, category, biller, item: plan.name, customer, reference },
        legs: [
          { account: `u:${req.uid}:main`, amount: -total },
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
          idem: `billrefund:${reference}`, kind: 'refund', userId: req.uid, meta: { reference },
          legs: [
            { account: `u:${req.uid}:main`, amount: total },
            { account: 'sys:external', amount: -amount },
            { account: 'sys:revenue', amount: -fee },
          ],
        });
        await c.query(`UPDATE bill_payments SET status='failed', error=$2 WHERE reference=$1`, [reference, result.msg || 'failed']);
      });
      throw httpErr(502, `${LABEL[category]} could not be paid. Your money has been returned to your wallet. Try again.`);
    }
    await q('UPDATE bill_payments SET status=$2, error=$3 WHERE reference=$1', [reference, result.status, result.msg || null]);
    res.json({ status: result.status, reference });
  }));
}
