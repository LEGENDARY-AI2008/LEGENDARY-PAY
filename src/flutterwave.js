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
