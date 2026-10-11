// Flutterwave integration (v3 API): virtual accounts for deposits, bank transfers for payouts.
// Replaces monnify.js and paystack.js. Same export names as before, so the rest of the backend works unchanged.
// Flutterwave amounts are in naira; our ledger is in kobo, so we convert at this boundary only.
import crypto from 'node:crypto';

const sandbox = () => process.env.SANDBOX === '1';
const key = () => process.env.FLW_SECRET_KEY || '';
const live = () => Boolean(key());
const BASE = 'https://api.flutterwave.com/v3';

async function call(path, method = 'GET', body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { authorization: 'Bearer ' + key(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ok: j.status === 'success', msg: j.message || `HTTP ${r.status}`, data: j.data };
}

// Flutterwave sends the secret hash you set in the dashboard in the "verif-hash" header.
export function verifyWebhook(sig) {
  const want = process.env.FLW_WEBHOOK_HASH || '';
  const a = Buffer.from(want), b = Buffer.from(String(sig || ''));
  return want !== '' && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Creates the user's personal funding account (a permanent virtual account).
// Accepts a BVN or a NIN. Only one is sent.
// NOT YET VERIFIED: confirm Flutterwave accepts the `nin` field on virtual accounts with a real test.
export async function createReservedAccount({ userId, email, fullName, phone, bvn, nin }) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    return { accountNumber: '9' + String(crypto.randomInt(0, 1e9)).padStart(9, '0'), bankName: 'Sandbox Bank' };
  }
  if (!bvn && !nin) throw Object.assign(new Error('Your BVN or NIN is needed to create your funding account'), { status: 400 });
  const parts = fullName.split(' ');
  const first = parts[0];
  const last = parts.slice(1).join(' ') || first;
  const id = bvn ? { bvn } : { nin };
  const r = await call('/virtual-account-numbers', 'POST', {
    email, is_permanent: true, ...id, phonenumber: phone, firstname: first, lastname: last,
    narration: `${fullName} Legendary Pay`, tx_ref: `va-${userId}`,
  });
  if (!r.ok || !r.data?.account_number) {
    throw Object.assign(new Error(r.msg || 'Could not create your funding account'), { status: 400 });
  }
  return { accountNumber: r.data.account_number, bankName: r.data.bank_name || 'Flutterwave' };
}

// Fallback list, used when no key is set. In live mode the full list comes from Flutterwave.
// Check these codes against GET /banks/NG before going live.
const STATIC_BANKS = [
  ['999992', 'OPay'], ['999991', 'PalmPay'], ['50515', 'Moniepoint'], ['50211', 'Kuda'], ['044', 'Access Bank'],
  ['058', 'GTBank'], ['057', 'Zenith Bank'], ['033', 'UBA'], ['011', 'First Bank'], ['070', 'Fidelity Bank'],
  ['214', 'FCMB'], ['232', 'Sterling Bank'], ['035', 'Wema Bank'], ['050', 'Ecobank'], ['032', 'Union Bank'], ['301', 'Jaiz Bank'],
].map(([code, name]) => ({ code, name }));
let banksCache = { v: null, exp: 0 };

export async function listBanks() {
  if (!live()) return STATIC_BANKS;
  if (banksCache.v && Date.now() < banksCache.exp) return banksCache.v;
  const r = await call('/banks/NG');
  const list = r.ok ? (r.data || []).map((b) => ({ code: String(b.code), name: b.name })) : [];
  if (!list.length) return STATIC_BANKS;
  banksCache = { v: list, exp: Date.now() + 24 * 3600 * 1000 };
  return list;
}

// Shows the account holder's name so users can confirm before sending.
export async function resolveBankAccount({ accountNumber, bankCode }) {
  if (!live()) return { accountName: 'SANDBOX ACCOUNT HOLDER' };
  const r = await call('/accounts/resolve', 'POST', { account_number: accountNumber, account_bank: bankCode });
  if (!r.ok || !r.data?.account_name) {
    throw Object.assign(new Error('We could not find that account. Check the number and the bank.'), { status: 404 });
  }
  return { accountName: r.data.account_name };
}

// Flutterwave transfer statuses: NEW, PENDING, SUCCESSFUL, FAILED.
const mapStatus = (s) => ({ SUCCESSFUL: 'success', FAILED: 'failed' }[String(s).toUpperCase()] || 'pending');

// Returns 'success' | 'failed' | 'not_found' | 'pending'
export async function payoutStatus(reference) {
  if (!live()) return 'success';
  const r = await call(`/transfers?reference=${encodeURIComponent(reference)}`);
  if (!r.ok) throw new Error('Flutterwave status check failed: ' + r.msg);
  const t = Array.isArray(r.data) ? r.data[0] : null;
  if (!t) return 'not_found';
  return mapStatus(t.status);
}

// Idempotent: the reference is derived from our payout id, and we check it before sending.
export async function payout(p) {
  const reference = `payout-${p.id}`;
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    console.log(`[sandbox payout] ${reference} amount=${p.amount} to ${p.account_number}/${p.bank_code}`);
    return { status: 'success' };
  }
  const known = await payoutStatus(reference);
  if (known !== 'not_found') return { status: known };
  const t = await call('/transfers', 'POST', {
    account_bank: p.bank_code, account_number: p.account_number, amount: Number(p.amount) / 100,
    narration: 'Wallet transfer', currency: 'NGN', reference,
  });
  if (!t.ok) throw new Error('Flutterwave payout failed: ' + t.msg);
  return { status: mapStatus(t.data?.status) };
}

// Airtime top-up through Flutterwave Bills.
// NOT YET VERIFIED against the live API: the first real call will show whether these fields are right.
// Returns 'success' | 'pending' | 'failed'. Only 'failed' triggers an automatic refund.
export async function payBill({ reference, customer, amount, network }) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    console.log(`[sandbox bill] ${reference} ${network} ${amount} to ${customer}`);
    return { status: 'success' };
  }
  const r = await call('/bills', 'POST', {
    country: 'NG', customer, amount: Number(amount) / 100, type: 'AIRTIME', network, reference,
  });
  if (r.http >= 500 || !r.data && !r.ok) return { status: 'pending', msg: r.msg };
  if (!r.ok) return { status: 'failed', msg: r.msg };
  const s = String(r.data?.status || '').toLowerCase();
  if (s === 'successful' || s === 'success') return { status: 'success' };
  if (s === 'failed') return { status: 'failed', msg: r.msg };
  return { status: 'pending', msg: r.msg };
}

// ---------- data, electricity and cable bills (UNVERIFIED against the live API) ----------
// The first real call shows whether these paths and fields are right. Check them in the Flutterwave
// dashboard before going live: the category names, the biller/item codes and the validate response.
// Sandbox mode (SANDBOX=1, no key) returns fixed test data so the screens can be tested.
const SANDBOX_BILLERS = {
  DATA: [{ code: 'MTN_DATA', name: 'MTN Data' }, { code: 'GLO_DATA', name: 'Glo Data' }, { code: 'AIRTEL_DATA', name: 'Airtel Data' }, { code: '9MOBILE_DATA', name: '9mobile Data' }],
  ELECTRICITY: [{ code: 'EKEDC', name: 'Eko Electric (EKEDC)' }, { code: 'IKEDC', name: 'Ikeja Electric (IKEDC)' }],
  CABLE: [{ code: 'DSTV', name: 'DStv' }, { code: 'GOTV', name: 'GOtv' }, { code: 'STARTIMES', name: 'StarTimes' }],
  EXAM: [{ code: 'WAEC', name: 'WAEC' }, { code: 'NECO', name: 'NECO' }, { code: 'JAMB', name: 'JAMB' }],
  INTERNET: [{ code: 'SPECTRANET', name: 'Spectranet' }, { code: 'SMILE', name: 'Smile' }],
  BETTING: [{ code: 'BET9JA', name: 'Bet9ja' }, { code: 'SPORTYBET', name: 'SportyBet' }],
  WATER: [{ code: 'WATER_A', name: 'Water provider A' }, { code: 'WATER_B', name: 'Water provider B' }],
  INSURANCE: [{ code: 'INS_A', name: 'Insurance provider A' }],
  WASTE: [{ code: 'WASTE_A', name: 'Waste provider A' }],
  SCHOOL: [{ code: 'SCHOOL_A', name: 'School fees provider A' }],
};
const CATEGORY_CODE = {
  DATA: 'DATA_BUNDLE', ELECTRICITY: 'ELECTRICITY_BILL', CABLE: 'CABLE_TV',
  EXAM: 'EXAM_PIN', INTERNET: 'INTERNET_SERVICE', BETTING: 'BETTING_WALLET',
  WATER: 'WATER_BILL', INSURANCE: 'INSURANCE_PREMIUM', WASTE: 'WASTE_BILL', SCHOOL: 'SCHOOL_FEES',
};

export async function listBillers(category) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    return SANDBOX_BILLERS[category] || [];
  }
  const r = await call(`/billers?country=NG&category=${CATEGORY_CODE[category]}`);
  if (!r.ok) throw new Error(r.msg || 'Could not load providers');
  return (r.data || []).map((b) => ({ code: b.biller_code, name: b.name }));
}

// Items are plans (data bundles, cable packages) or meter types for electricity.
// amount is in naira; amountKobo is 0 when the amount is chosen by the user.
export async function listBillerItems(billerCode, category) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    if (category === 'ELECTRICITY') return [{ code: 'PREPAID', name: 'Prepaid meter', amountKobo: 0 }, { code: 'POSTPAID', name: 'Postpaid meter', amountKobo: 0 }];
    if (category === 'DATA') return [{ code: `${billerCode}-1GB`, name: '1GB, 30 days', amountKobo: 100_000 }, { code: `${billerCode}-2GB`, name: '2GB, 30 days', amountKobo: 200_000 }];
    if (['WATER', 'INSURANCE', 'WASTE', 'SCHOOL'].includes(category)) return [{ code: `${billerCode}-BILL`, name: 'Bill payment', amountKobo: 0 }];
    if (category === 'EXAM') return [{ code: `${billerCode}-PIN`, name: `${billerCode} result checker PIN`, amountKobo: 360_000 }];
    if (category === 'INTERNET') return [{ code: `${billerCode}-1MTH`, name: '1 month plan', amountKobo: 1_500_000 }];
    if (category === 'BETTING') return [{ code: `${billerCode}-FUND`, name: 'Wallet funding', amountKobo: 0 }];
    return [{ code: `${billerCode}-BASIC`, name: 'Basic', amountKobo: 1_850_000 }, { code: `${billerCode}-FULL`, name: 'Full', amountKobo: 2_500_000 }];
  }
  const r = await call(`/billers/${encodeURIComponent(billerCode)}/items`);
  if (!r.ok) throw new Error(r.msg || 'Could not load plans');
  return (r.data || []).map((i) => ({
    code: i.item_code, name: i.name, amountKobo: Math.round(Number(i.amount || 0) * 100),
  }));
}

// Checks the meter or smartcard number and returns the owner's name, before any money moves.
export async function validateBillCustomer({ billerCode, itemCode, customer }) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    return { name: 'Test Customer' };
  }
  const r = await call(`/billers/${encodeURIComponent(billerCode)}/items/${encodeURIComponent(itemCode)}/validate?customer=${encodeURIComponent(customer)}`);
  if (!r.ok) throw new Error(r.msg || 'Could not check this number');
  return { name: r.data?.name || r.data?.customer_name || 'Customer found' };
}

// Pays a bill. Same return contract as payBill(): 'success' | 'pending' | 'failed'.
export async function payBillItem({ reference, category, billerCode, itemCode, customer, amountKobo }) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    console.log(`[sandbox bill] ${reference} ${category} ${billerCode}/${itemCode} ${amountKobo} to ${customer}`);
    return { status: 'success' };
  }
  const r = await call('/bills', 'POST', {
    country: 'NG', customer, amount: amountKobo / 100, recurrence: 'ONCE',
    type: itemCode, biller_code: billerCode, reference,
  });
  if (r.http >= 500 || !r.data && !r.ok) return { status: 'pending', msg: r.msg };
  if (!r.ok) return { status: 'failed', msg: r.msg };
  const s = String(r.data?.status || '').toLowerCase();
  if (s === 'successful' || s === 'success') return { status: 'success' };
  if (s === 'failed') return { status: 'failed', msg: r.msg };
  return { status: 'pending', msg: r.msg };
}
