// Flutterwave integration (v3 API): virtual accounts for deposits, bank transfers for payouts.
// Replaces monnify.js and paystack.js. Same export names as before, so the rest of the backend works unchanged.
// Flutterwave amounts are in naira; our ledger is in kobo, so we convert at this boundary only.
import crypto from 'node:crypto';

const sandbox = () => process.env.SANDBOX === '1';
const key = () => process.env.FLW_SECRET_KEY || '';
const live = () => Boolean(key());
// Calls go straight to Flutterwave, or through our fixed-IP forwarder when FLW_PROXY_URL is set.
// The forwarder passes the key on, over HTTPS only, and needs PROXY_KEY to accept a call.
const PROXY = process.env.FLW_PROXY_URL ? process.env.FLW_PROXY_URL.replace(/\/$/, '') : '';
const BASE = PROXY ? `${PROXY}/v3` : 'https://api.flutterwave.com/v3';

async function call(path, method = 'GET', body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      authorization: 'Bearer ' + key(),
      'content-type': 'application/json',
      ...(PROXY ? { 'x-proxy-key': process.env.PROXY_KEY || '' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Read the raw reply, so a non-JSON error (proxy or firewall page) is still visible in the diagnostic.
  const text = await r.text().catch(() => '');
  let j = {};
  try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
  return {
    http: r.status, ok: j.status === 'success', msg: j.message || `HTTP ${r.status}`, data: j.data,
    detail: text.slice(0, 300),
  };
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
].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
let banksCache = { v: null, exp: 0 };

export async function listBanks() {
  if (!live()) return STATIC_BANKS;
  if (banksCache.v && Date.now() < banksCache.exp) return banksCache.v;
  const r = await call('/banks/NG');
  // Sorted A to Z, so the bank list in the app is alphabetical.
  const list = r.ok ? (r.data || []).map((b) => ({ code: String(b.code), name: b.name })).sort((a, b) => a.name.localeCompare(b.name)) : [];
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
    console.log(`[sandbox payout] ${reference} amount=${p.amount} to ...${String(p.account_number).slice(-4)}/${p.bank_code}`);
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
// Flutterwave needs the network's own airtime item (found in its airtime list), not the network name.
// Only a confirmed "successful" counts as success. Anything unclear is looked up before we decide.
// Returns 'success' | 'pending' | 'failed'. Only 'failed' triggers an automatic refund.
const AIRTIME_WORDS = { MTN: /\bMTN\b/i, GLO: /\bGLO\b/i, AIRTEL: /AIRTEL/i, '9MOBILE': /9\s?MOBILE|ETISALAT/i };

let airtimeCache = { v: null, exp: 0 };
async function airtimeRows() {
  if (airtimeCache.v && Date.now() < airtimeCache.exp) return airtimeCache.v;
  let r = await call('/bill-categories?airtime=1');
  let rows = r.ok && Array.isArray(r.data) ? r.data : [];
  if (!rows.length) {
    // Fallback: the flag-less list, keeping only the rows Flutterwave marks as airtime.
    const all = await call('/bill-categories');
    rows = (all.ok && Array.isArray(all.data) ? all.data : []).filter((x) => Number(x.is_airtime) === 1);
  }
  airtimeCache = { v: rows, exp: Date.now() + 3600 * 1000 };
  return rows;
}

async function airtimeItemFor(network) {
  const re = AIRTIME_WORDS[network];
  if (!re) return null;
  const rows = (await airtimeRows()).filter((x) => re.test(`${x.name || ''} ${x.biller_name || ''} ${x.short_name || ''}`));
  const row = rows.find((x) => Number(x.is_airtime) === 1) || rows[0];
  return row ? { billerCode: row.biller_code, itemCode: row.item_code } : null;
}

// Asks Flutterwave for the final result of one reference (a few short checks).
async function verifyBill(reference, msg) {
  for (let i = 0; i < 2; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    const v = await call(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    const s = String(v.data?.status || '').toLowerCase();
    if (s === 'successful' || s === 'success') return { status: 'success' };
    if (s === 'failed') return { status: 'failed', msg: v.data?.processor_response || msg };
  }
  return { status: 'pending', msg };
}

async function finalStatus(status, reference, msg) {
  const s = String(status || '').toLowerCase();
  if (s === 'successful' || s === 'success') return { status: 'success' };
  if (s === 'failed') return { status: 'failed', msg };
  return verifyBill(reference, msg);
}

export async function payBill({ reference, customer, amount, network }) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    console.log(`[sandbox bill] ${reference} ${network} ${amount} to ...${String(customer).slice(-4)}`);
    return { status: 'success' };
  }
  const item = await airtimeItemFor(network);
  if (!item) {
    const rows = await airtimeRows();
    console.log(`[airtime] ${reference} network=${network} NO ITEM FOUND. airtime rows from Flutterwave=${rows.length}`);
    return { status: 'failed', msg: `No airtime item found for ${network}` };
  }
  const r = await call('/bills', 'POST', {
    country: 'NG', customer, amount: Number(amount) / 100, recurrence: 'ONCE',
    type: item.itemCode, biller_name: item.billerCode, reference,
  });
  console.log(`[airtime] ${reference} network=${network} item=${item.itemCode} biller=${item.billerCode} http=${r.http} ok=${r.ok} status=${r.data?.status ?? '-'} msg=${r.msg}`);
  // Server error or no answer: we cannot tell, so check Flutterwave before deciding.
  if (r.http >= 500) return verifyBill(reference, r.msg);
  // Flutterwave refused the request (bad network item, wrong key, validation): it was never sent, so refund.
  if (!r.ok) return { status: 'failed', msg: r.msg };
  return finalStatus(r.data?.status, reference, r.msg);
}

// ---------- data, electricity, cable and other bills ----------
// Routes follow Flutterwave's Java SDK (flutterwave/java-v3, Bills.java):
//   GET  /bill-categories?<flag>=1        list providers (flag = data_bundle, power, cable, internet)
//   GET  /bill-categories?biller_code=X   list plans/items for one provider
//   GET  /bill-items/{item}/validate?code=&customer=   check the meter or smartcard number
//   POST /bills                           pay the bill
// UNVERIFIED on the live account: the field names in the responses and the `type` value sent on payment.
// Check the first real DStv payment in the dashboard before going live.
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

// Query flag that the SDK's getCategories() sends for each service.
const CATEGORY_FLAG = { DATA: 'data_bundle', ELECTRICITY: 'power', CABLE: 'cable', INTERNET: 'internet' };

// Services with no flag: Flutterwave's flag-less list is searched by provider name instead.
const KEYWORDS = {
  EXAM: /WAEC|NECO|JAMB|NABTEB|EXAM|RESULT CHECK|ENTRANCE/i,
  BETTING: /BET9JA|BETKING|1XBET|BETWAY|NAIRABET|SPORTYBET|MERRYBET|BETBIGA|BETLION|BETTING|SPORT/i,
  WATER: /WATER/i,
  INSURANCE: /INSUR|AIICO|LEADWAY|AXA|SUNU|HYGEIA/i,
  WASTE: /WASTE|RUBBISH|SANITAT/i,
  SCHOOL: /SCHOOL|TUITION|UNIVERSITY|POLYTECHNIC|COLLEGE|ACADEMY/i,
};

// Named providers inside each keyword service. A plan goes under the first name it matches.
const BRANDS = {
  EXAM: [['WAEC', /WAEC/i], ['NECO', /NECO/i], ['JAMB', /JAMB/i], ['NABTEB', /NABTEB/i], ['Common Entrance', /ENTRANCE/i]],
  BETTING: [['Bet9ja', /BET9JA/i], ['SportyBet', /SPORTY/i], ['BetKing', /BETKING/i], ['1xBet', /1X ?BET/i], ['Betway', /BETWAY/i], ['NairaBet', /NAIRABET/i], ['MerryBet', /MERRYBET/i], ['BetBiga', /BETBIGA/i], ['BetLion', /BETLION/i]],
  WATER: [['Water', /WATER/i]],
  INSURANCE: [['AIICO', /AIICO/i], ['Leadway', /LEADWAY/i], ['AXA Mansard', /AXA/i], ['Insurance', /INSUR/i]],
  WASTE: [['Waste', /WASTE|RUBBISH|SANITAT/i]],
  SCHOOL: [['School fees', /SCHOOL|TUITION/i], ['University', /UNIVERSITY|POLYTECHNIC|COLLEGE|ACADEMY/i]],
};

// Data bundles are grouped by provider code, and the network name is found in the plan names.
const NETWORK_WORDS = [['MTN', /\bMTN\b/i], ['Glo', /\bGLO\b/i], ['Airtel', /AIRTEL/i], ['9mobile', /9\s?MOBILE|ETISALAT/i]];

const textOf = (b) => `${b.name || ''} ${b.biller_name || ''} ${b.short_name || ''}`;

let allRowsCache = { v: null, exp: 0 };
async function allBillRows() {
  if (allRowsCache.v && Date.now() < allRowsCache.exp) return allRowsCache.v;
  const r = await call('/bill-categories');
  if (!r.ok) throw new Error(r.msg || 'Could not load providers');
  allRowsCache = { v: r.data || [], exp: Date.now() + 3600 * 1000 };
  return allRowsCache.v;
}

export async function listBillers(category) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    return SANDBOX_BILLERS[category] || [];
  }
  let rows;
  if (CATEGORY_FLAG[category]) {
    const r = await call(`/bill-categories?${CATEGORY_FLAG[category]}=1`);
    if (!r.ok) throw new Error(r.msg || 'Could not load providers');
    rows = r.data || [];
  } else if (KEYWORDS[category]) {
    const re = KEYWORDS[category];
    rows = (await allBillRows()).filter((b) => re.test(textOf(b)));
  } else {
    return [];
  }
  const groups = new Map();
  for (const b of rows) {
    const text = textOf(b);
    let key, name;
    if (category === 'DATA') {
      // One row per plan: keep one row per provider code, named by its network.
      const net = NETWORK_WORDS.find(([, re]) => re.test(text));
      key = b.biller_code;
      name = net ? net[0] : `Other network (${b.biller_code})`;
    } else if (KEYWORDS[category]) {
      // Group by named provider, so each provider gets its own row.
      const brand = (BRANDS[category] || []).find(([, re]) => re.test(text));
      name = brand ? brand[0] : String(b.biller_name || b.name || b.biller_code).slice(0, 40);
      key = name;
    } else {
      key = b.biller_code;
      name = b.biller_name || b.name || b.biller_code;
    }
    if (!groups.has(key)) groups.set(key, { code: b.biller_code, name });
  }
  return [...groups.values()];
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
  const r = await call(`/bill-categories?biller_code=${encodeURIComponent(billerCode)}`);
  if (!r.ok) throw new Error(r.msg || 'Could not load plans');
  return (r.data || []).map((i) => ({
    code: i.item_code,
    name: i.name || i.item_name || i.item_code,
    amountKobo: Math.round(Number(i.amount || 0) * 100),
  }));
}

// Checks the meter or smartcard number and returns the owner's name, before any money moves.
export async function validateBillCustomer({ billerCode, itemCode, customer }) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    return { name: 'Test Customer' };
  }
  const r = await call(`/bill-items/${encodeURIComponent(itemCode)}/validate?code=${encodeURIComponent(billerCode)}&customer=${encodeURIComponent(customer)}`);
  if (!r.ok) throw new Error(r.msg || 'Could not check this number');
  return { name: r.data?.name || r.data?.customer_name || 'Customer found' };
}

// Pays a bill. Same return contract as payBill(): 'success' | 'pending' | 'failed'.
export async function payBillItem({ reference, category, billerCode, itemCode, customer, amountKobo }) {
  if (!live()) {
    if (!sandbox()) throw new Error('Flutterwave key is missing');
    console.log(`[sandbox bill] ${reference} ${category} ${billerCode}/${itemCode} ${amountKobo} to ...${String(customer).slice(-4)}`);
    return { status: 'success' };
  }
  const r = await call('/bills', 'POST', {
    country: 'NG', customer, amount: amountKobo / 100, recurrence: 'ONCE',
    type: itemCode, biller_name: billerCode, reference,
  });
  if (r.http >= 500 || !r.data && !r.ok) return { status: 'pending', msg: r.msg };
  if (!r.ok) return { status: 'failed', msg: r.msg };
  const s = String(r.data?.status || '').toLowerCase();
  if (s === 'successful' || s === 'success') return { status: 'success' };
  if (s === 'failed') return { status: 'failed', msg: r.msg };
  return { status: 'pending', msg: r.msg };
}

// Admin diagnostic: shows what Flutterwave returns for the provider lists (field names and category names).
// It never returns the key. Only provider rows come back.
export async function billDebug() {
  if (!live()) return { note: 'Live key is not set on this server' };
  const out = {};
  for (const path of ['/bill-categories', '/bill-categories?data_bundle=1', '/bill-categories?power=1', '/bill-categories?airtime=1']) {
    const r = await call(path);
    const rows = Array.isArray(r.data) ? r.data : [];
    const fields = new Set();
    rows.forEach((x) => Object.keys(x || {}).forEach((k) => fields.add(k)));
    const categoryNames = new Set(rows.map((x) => x.category_name).filter(Boolean));
    out[path] = {
      ok: Boolean(r.ok), message: r.msg || null, detail: r.detail || null, count: rows.length,
      fields: [...fields], categoryNames: [...categoryNames].slice(0, 80), sample: rows.slice(0, 3),
    };
  }
  // The airtime rows the payment code uses, and which one it picks for each network.
  const air = (await airtimeRows()).map((x) => ({
    name: x.name, biller_name: x.biller_name, biller_code: x.biller_code, item_code: x.item_code,
    is_airtime: x.is_airtime, amount: x.amount,
  }));
  out.airtimeUsed = air.slice(0, 60);
  out.airtimePicked = Object.fromEntries(Object.keys(AIRTIME_WORDS).map((n) => {
    const hit = air.find((x) => AIRTIME_WORDS[n].test(`${x.name || ''} ${x.biller_name || ''}`));
    return [n, hit ? { biller_code: hit.biller_code, item_code: hit.item_code } : null];
  }));
  return out;
}
