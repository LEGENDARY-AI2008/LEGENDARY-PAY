import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q, tx, settings } from './db.js';
import { post, INSUFFICIENT } from './ledger.js';
import { enqueue } from './jobs.js';
import { queueGrant } from './bonus.js';
import { settlePayout } from './payouts.js';
import { createReservedAccount, listBanks, resolveBankAccount, verifyWebhook, payBill, billDebug } from './flutterwave.js';
import { sendMail } from './mail.js';
import { alert } from './alert.js';
import { mountFeatures, applyRoundUp } from './features.js';
import { mountSupport } from './support.js';
import { mountWebAuthn, verifyApproval } from './webauthn.js';
import { mountTransactions } from './transactions.js';
import { mountBills, billFeeKobo } from './bills.js';
import { mountAccount } from './account.js';
import { mountStaff } from './staff.js';
import { pushUsers, pushToStaff, mountPush } from './push.js';

const sandbox = process.env.SANDBOX === '1';
const required = ['DATABASE_URL', 'JWT_SECRET',
  ...(sandbox ? [] : ['FLW_SECRET_KEY', 'FLW_WEBHOOK_HASH'])];
for (const k of required) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
// Live Flutterwave keys start with FLWSECK- (test keys start with FLWSECK_TEST-). Never allow sandbox mode with live keys.
if (sandbox && /^FLWSECK-/.test(process.env.FLW_SECRET_KEY || '')) {
  console.error('SANDBOX=1 must never be used with a live Flutterwave key'); process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : true }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/lookup', rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: true, legacyHeaders: false }));
app.use(['/auth', '/kyc'], rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));

const maskName = (n) => (n ? n.split(' ').map((w, i) => (i === 0 ? w : w[0] + '***')).join(' ') : 'Wallet user');
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const h = (fn) => (req, res, next) => fn(req, res).catch(next);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Emails a fresh 6-digit code and stores only its hash (15 minutes, 5 tries).
async function sendVerifyCode(uid, email) {
  const code = String(crypto.randomInt(100000, 1000000));
  await q(`UPDATE users SET verify_hash=$2, verify_expires=now() + interval '15 minutes', verify_tries=0 WHERE id=$1`, [uid, sha(code)]);
  await sendMail(email, 'Your verification code', `Your Legendary Pay code is ${code}. It expires in 15 minutes. If you did not sign up, ignore this email.`);
}
async function requireEmailVerified(uid) {
  const ok = (await q('SELECT email_verified FROM users WHERE id=$1', [uid])).rows[0]?.email_verified === true;
  if (!ok) throw httpErr(403, 'Verify your email first');
}
const naira = (k) => '₦' + (k / 100).toLocaleString('en-NG');
const sign = (id) => jwt.sign({ uid: id }, process.env.JWT_SECRET, { expiresIn: '7d' });
const validAmount = (n) => Number.isInteger(n) && n >= 1000 && n <= 50_000_000; // N10 .. N500,000 (kobo)
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
// Emails a user in the background. Never blocks the request; failures are only logged.
// Saves the message in the app's notification list and emails it. Failures are only logged.
function notify(userId, subject, text) {
  q('INSERT INTO notifications(user_id, title, body) VALUES($1,$2,$3)', [userId, subject, text])
    .catch((e) => console.error('notification save failed', e.message));
  q('SELECT email FROM users WHERE id=$1', [userId])
    .then((r) => (r.rows[0]?.email ? sendMail(r.rows[0].email, subject, text) : null))
    .catch((e) => console.error('notify failed', e.message));
  pushUsers([userId], { title: subject, body: String(text || '').slice(0, 140) })
    .catch((e) => console.error('push failed', e.message));
}

// Checks the token, then that the account has not been deleted (a deleted account's old token stops working at once).
function auth(req, _res, next) {
  let uid;
  try { uid = jwt.verify((req.get('authorization') || '').replace('Bearer ', ''), process.env.JWT_SECRET).uid; }
  catch { return next(httpErr(401, 'Unauthorized')); }
  q('SELECT deleted_at FROM users WHERE id=$1', [uid]).then((r) => {
    if (!r.rows[0] || r.rows[0].deleted_at) return next(httpErr(401, 'Unauthorized'));
    req.uid = uid;
    next();
  }).catch(next);
}
// Admin = the account whose verified email equals ADMIN_EMAIL. It logs in like any other user.
const isAdminUser = (u) => {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return Boolean(adminEmail) && u?.email === adminEmail && u?.email_verified === true;
};
// Support staff or admins: used for the live chat inbox.
async function staffOrAdmin(req, res, next) {
  auth(req, res, async (err) => {
    if (err) return next(err);
    try {
      const u = (await q('SELECT email, email_verified, staff_role FROM users WHERE id=$1', [req.uid])).rows[0];
      if (!u || (!isAdminUser(u) && u.staff_role !== 'support')) return next(httpErr(403, 'Staff only'));
      next();
    } catch (e) { next(e); }
  });
}
async function admin(req, res, next) {
  auth(req, res, async (err) => {
    if (err) return next(err);
    try {
      const u = (await q('SELECT email, email_verified FROM users WHERE id=$1', [req.uid])).rows[0];
      if (!isAdminUser(u)) return next(httpErr(403, 'Admins only'));
      next();
    } catch (e) { next(e); }
  });
}

// Every debit is approved by fingerprint (approval) or by the 4-digit PIN.
async function checkPin(userId, pin, approval) {
  if (approval) return verifyApproval({ q, httpErr, uid: userId, approval });
  const u =(await q('SELECT pin_hash, pin_fails, locked_until FROM users WHERE id=$1', [userId])).rows[0];
  if (!u) throw httpErr(401, 'Unauthorized');
  if (u.locked_until && u.locked_until > new Date()) throw httpErr(423, 'PIN locked, try again later');
  if (await bcrypt.compare(String(pin || ''), u.pin_hash)) {
    if (u.pin_fails) await q('UPDATE users SET pin_fails=0 WHERE id=$1', [userId]);
    return;
  }
  const f = u.pin_fails + 1;
  await q(
    `UPDATE users SET pin_fails = CASE WHEN $2::int >= 5 THEN 0 ELSE $2::int END,
       locked_until = CASE WHEN $2::int >= 5 THEN now() + interval '30 minutes' END WHERE id=$1`, [userId, f]);
  throw httpErr(401, 'Wrong PIN');
}

async function isVerified(uid) {
  return (await q('SELECT kyc_verified FROM users WHERE id=$1', [uid])).rows[0]?.kyc_verified === true;
}
async function checkLimit(uid, verified, amount) {
  const s = await settings();
  const used = Number((await q(
    `SELECT COALESCE(SUM((meta->>'amount')::bigint),0) AS t FROM journal
     WHERE user_id=$1 AND kind IN ('internal_transfer','bank_transfer') AND created_at >= date_trunc('day', now())`, [uid])).rows[0].t);
  const limit = verified ? s.daily_limit_verified : s.daily_limit_unverified;
  if (used + amount > limit) {
    throw httpErr(403, `Daily limit reached. You can send up to ${naira(limit)} per day${verified ? '' : ' until you verify your identity'}.`);
  }
}

// ---------- auth ----------
app.post('/auth/signup', h(async (req, res) => {
  const { phone, pin, referralCode, deviceId } = req.body || {};
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^0\d{10}$/.test(phone || '') || !/^\d{4}$/.test(pin || '')) throw httpErr(400, 'Invalid phone or PIN');
  if (!validEmail(email)) throw httpErr(400, 'Enter a valid email address');
  try {
    const user = await tx(async (c) => {
      let referrer = null;
      if (referralCode) referrer = (await c.query('SELECT id FROM users WHERE referral_code=$1', [String(referralCode).toUpperCase()])).rows[0];
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const u = (await c.query(
        `INSERT INTO users(phone, email, pin_hash, referral_code, referred_by, device_id, account_number)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, referral_code, account_number`,
        [phone, email, await bcrypt.hash(pin, 10), code, referrer?.id || null, deviceId || null, phone.slice(1)]
      )).rows[0];
      await c.query(`INSERT INTO accounts(code, user_id, kind) VALUES($1,$2,'main'), ($3,$2,'bonus')`,
        [`u:${u.id}:main`, u.id, `u:${u.id}:bonus`]);
      return u;
    });
    sendVerifyCode(user.id, email).catch((e) => console.error('verify mail failed', e));
    res.status(201).json({ token: sign(user.id), accountNumber: user.account_number, referralCode: user.referral_code });
  } catch (e) {
    if (e.code === '23505') throw httpErr(409, 'Phone number or email already registered');
    throw e;
  }
}));

app.post('/auth/verify-email', auth, h(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw httpErr(400, 'Enter the 6-digit code');
  const u = (await q('SELECT email_verified, verify_hash, verify_expires, verify_tries FROM users WHERE id=$1', [req.uid])).rows[0];
  if (!u) throw httpErr(401, 'Unauthorized');
  if (u.email_verified) return res.json({ ok: true });
  if (!u.verify_hash || !u.verify_expires || u.verify_expires < new Date() || u.verify_tries >= 5) {
    throw httpErr(400, 'Code expired. Ask for a new one.');
  }
  if (!safeEq(sha(code), u.verify_hash)) {
    await q('UPDATE users SET verify_tries=verify_tries+1 WHERE id=$1', [req.uid]);
    throw httpErr(400, 'Wrong code');
  }
  await q('UPDATE users SET email_verified=true, verify_hash=NULL, verify_expires=NULL, verify_tries=0 WHERE id=$1', [req.uid]);
  res.json({ ok: true });
}));

app.post('/auth/resend-verify', auth, h(async (req, res) => {
  const u = (await q('SELECT email, email_verified FROM users WHERE id=$1', [req.uid])).rows[0];
  if (!u) throw httpErr(401, 'Unauthorized');
  if (u.email_verified) return res.json({ ok: true });
  await sendVerifyCode(req.uid, u.email);
  res.json({ ok: true });
}));

app.post('/auth/login', h(async (req, res) => {
  const { identifier, phone, pin } = req.body || {};
  const idf = String(identifier || phone || '').trim().toLowerCase();
  const u = (await q('SELECT id FROM users WHERE (phone=$1 OR email=$1) AND deleted_at IS NULL', [idf])).rows[0];
  if (!u) throw httpErr(401, 'Wrong phone/email or PIN');
  await checkPin(u.id, pin);
  res.json({ token: sign(u.id) });
}));

// PIN reset by email code. Same reply whether or not the email exists.
app.post('/auth/forgot', h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = (await q('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (u) {
    const code = String(crypto.randomInt(100000, 1000000));
    await q(
      `INSERT INTO pin_resets(email, code_hash, expires_at, tries) VALUES($1,$2, now() + interval '15 minutes', 0)
       ON CONFLICT (email) DO UPDATE SET code_hash=$2, expires_at = now() + interval '15 minutes', tries=0`, [email, sha(code)]);
    await sendMail(email, 'Your PIN reset code', `Your code is ${code}. It expires in 15 minutes. If you did not ask for this, ignore this email.`);
  }
  res.json({ ok: true });
}));

app.post('/auth/reset', h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const { code, newPin } = req.body || {};
  if (!/^\d{6}$/.test(code || '') || !/^\d{4}$/.test(newPin || '')) throw httpErr(400, 'Invalid code or PIN');
  const r = (await q('SELECT * FROM pin_resets WHERE email=$1', [email])).rows[0];
  if (!r || r.expires_at < new Date() || r.tries >= 5) throw httpErr(400, 'Code expired. Ask for a new one.');
  if (!safeEq(sha(String(code)), r.code_hash)) {
    await q('UPDATE pin_resets SET tries=tries+1 WHERE email=$1', [email]);
    throw httpErr(400, 'Wrong code');
  }
  await q('UPDATE users SET pin_hash=$2, pin_fails=0, locked_until=NULL WHERE email=$1', [email, await bcrypt.hash(newPin, 10)]);
  await q('DELETE FROM pin_resets WHERE email=$1', [email]);
  res.json({ ok: true });
}));

// ---------- identity check + funding account ----------
app.post('/kyc/verify', auth, h(async (req, res) => {
  await requireEmailVerified(req.uid);
  const fullName = String(req.body?.fullName || '').trim().replace(/\s+/g, ' ');
  const idType = req.body?.idType === 'nin' ? 'nin' : 'bvn';
  const idNumber = String(req.body?.idNumber || '').trim();
  if (fullName.split(' ').length < 2 || fullName.length < 5) throw httpErr(400, 'Enter your full name as it appears on your ID');
  if (!/^\d{11}$/.test(idNumber)) throw httpErr(400, `${idType.toUpperCase()} must be 11 digits`);
  const u = (await q('SELECT id, email, phone, kyc_verified FROM users WHERE id=$1', [req.uid])).rows[0];
  if (u.kyc_verified) throw httpErr(409, 'Already verified');
  // We keep only a keyed fingerprint (never the number) so one ID cannot open many wallets and farm bonuses.
  const fingerprint = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${idType}:${idNumber}`).digest('hex');
  if ((await q('SELECT 1 FROM users WHERE kyc_hash=$1', [fingerprint])).rowCount) throw httpErr(409, 'This ID is already linked to another wallet');
  const acc = await createReservedAccount({
    userId: u.id, email: u.email, fullName, phone: u.phone,
    bvn: idType === 'bvn' ? idNumber : undefined,
    nin: idType === 'nin' ? idNumber : undefined,
  });
  try {
    await q(`UPDATE users SET full_name=$2, kyc_hash=$3, kyc_verified=true, virtual_account=$4, virtual_bank=$5 WHERE id=$1`,
      [u.id, fullName, fingerprint, acc.accountNumber, acc.bankName]);
  } catch (e) {
    if (e.code === '23505') throw httpErr(409, 'This ID is already linked to another wallet');
    throw e;
  }
  await enqueue(null, 'evaluate_bonuses', { userId: u.id });
  res.json({ virtualAccount: acc.accountNumber, bank: acc.bankName });
}));

// ---------- wallet ----------
app.get('/wallet', auth, h(async (req, res) => {
  const r = await q('SELECT kind, balance FROM accounts WHERE user_id=$1', [req.uid]);
  const u = (await q(
    'SELECT account_number, email, phone, referral_code, kyc_verified, email_verified, full_name, virtual_account, virtual_bank, staff_role FROM users WHERE id=$1', [req.uid])).rows[0];
  const bal = Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.balance)]));
  res.json({ ...u, mainKobo: bal.main, bonusKobo: bal.bonus, is_admin: isAdminUser(u) });
}));

app.get('/wallet/history', auth, h(async (req, res) => {
  const r = await q(
    `SELECT j.id, j.kind, e.amount, j.created_at, j.meta FROM entries e
     JOIN accounts a ON a.id = e.account_id JOIN journal j ON j.id = e.journal_id
     WHERE a.user_id=$1 AND (a.kind='main' OR j.kind='bonus') ORDER BY e.id DESC LIMIT 50`, [req.uid]);
  res.json(r.rows.map((x) => ({ id: x.id, kind: x.kind, amountKobo: Number(x.amount), at: x.created_at, type: x.meta?.type || null })));
}));

// One transaction's details, only if it belongs to this user.
app.get('/wallet/receipt/:id', auth, h(async (req, res) => {
  if (!isUuid(req.params.id)) throw httpErr(404, 'Receipt not found');
  const j = (await q(
    `SELECT j.id, j.kind, j.idem_key, j.meta, j.created_at,
       (SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN accounts a ON a.id = e.account_id
          WHERE e.journal_id = j.id AND a.user_id = $2) AS amount
     FROM journal j WHERE j.id = $1 AND EXISTS (
       SELECT 1 FROM entries e JOIN accounts a ON a.id = e.account_id
         WHERE e.journal_id = j.id AND a.user_id = $2)`, [req.params.id, req.uid])).rows[0];
  if (!j) throw httpErr(404, 'Receipt not found');
  const payout = j.kind === 'bank_transfer'
    ? (await q('SELECT fee, status, bank_code, account_number FROM payouts WHERE idem=$1', [j.idem_key])).rows[0] || null
    : null;
  res.json({
    id: j.id,
    kind: j.kind,
    amountKobo: Number(j.amount),
    at: j.created_at,
    reference: j.meta?.reference || null,
    note: j.meta?.note || null,
    bankAccount: payout ? payout.account_number : null,
    feeKobo: payout ? Number(payout.fee) : 0,
    status: payout ? payout.status : 'success',
  });
}));

// Change PIN: needs the current PIN.
app.post('/me/pin', auth, h(async (req, res) => {
  const { oldPin, newPin } = req.body || {};
  if (!/^\d{4}$/.test(newPin || '')) throw httpErr(400, 'New PIN must be 4 digits');
  await checkPin(req.uid, oldPin);
  await q('UPDATE users SET pin_hash=$2, pin_fails=0, locked_until=NULL WHERE id=$1', [req.uid, await bcrypt.hash(newPin, 10)]);
  notify(req.uid, 'Your PIN was changed', 'Your Legendary Pay PIN was just changed. If this was not you, reset your PIN now.');
  res.json({ ok: true });
}));

// Change email: needs the PIN. The new email must be verified again.
app.post('/me/email', auth, h(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!validEmail(email)) throw httpErr(400, 'Enter a valid email address');
  await checkPin(req.uid, req.body?.pin);
  try {
    await q('UPDATE users SET email=$2, email_verified=false WHERE id=$1', [req.uid, email]);
  } catch (e) {
    if (e.code === '23505') throw httpErr(409, 'That email is already used by another wallet');
    throw e;
  }
  sendVerifyCode(req.uid, email).catch((e) => console.error('verify mail failed', e));
  res.json({ ok: true });
}));

// Bonus and reward history for the rewards page.
app.get('/rewards/list', auth, h(async (req, res) => {
  const r = await q(
    `SELECT type, amount, status, created_at FROM bonus_grants WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [req.uid]);
  res.json(r.rows.map((x) => ({ type: x.type, amountKobo: Number(x.amount), status: x.status, at: x.created_at })));
}));

app.post('/transfer/internal', auth, h(async (req, res) => {
  await requireEmailVerified(req.uid);
  const { toAccount, amount, pin, idemKey, saveAs, note, requestId } = req.body || {};
  if (!validAmount(amount) || !idemKey) throw httpErr(400, 'Invalid request');
  await checkPin(req.uid, pin, req.body?.approval);
  await checkLimit(req.uid, await isVerified(req.uid), amount);
  const to = (await q('SELECT id FROM users WHERE account_number=$1', [toAccount])).rows[0];
  if (!to || to.id === req.uid) throw httpErr(400, 'Invalid recipient');
  const cleanNote = String(note || '').trim().slice(0, 60);
  // Paying a money request: it must still be pending, for this amount, to the person who asked.
  let reqRow = null;
  if (requestId) {
    if (!/^\d+$/.test(String(requestId))) throw httpErr(400, 'Invalid request');
    reqRow = (await q(
      `SELECT id, from_user, amount FROM money_requests WHERE id=$1 AND to_user=$2 AND status='pending'`,
      [requestId, req.uid])).rows[0];
    if (!reqRow || Number(reqRow.amount) !== amount || reqRow.from_user !== to.id) {
      throw httpErr(400, 'That payment request is no longer valid');
    }
  }
  const r = await tx(async (c) => {
    const p = await post(c, {
      idem: `it:${req.uid}:${idemKey}`, kind: 'internal_transfer', userId: req.uid,
      meta: { amount, to: to.id, note: cleanNote || undefined },
      legs: [{ account: `u:${req.uid}:main`, amount: -amount }, { account: `u:${to.id}:main`, amount }],
    });
    await enqueue(c, 'evaluate_bonuses', { userId: req.uid });
    return p;
  });
  if (!r.duplicate) {
    notify(req.uid, 'Money sent', `You sent ${naira(amount)} to wallet ${toAccount}.`);
    notify(to.id, 'Money received', `You received ${naira(amount)} from another Legendary Pay wallet.`);
    if (reqRow) await q(`UPDATE money_requests SET status='paid' WHERE id=$1`, [reqRow.id]);
    await applyRoundUp({ q, tx, uid: req.uid, amount, idem: `it:${req.uid}:${idemKey}` });
  }
  if (saveAs) await saveBeneficiary(req.uid, { type: 'wallet', label: saveAs, accountNumber: toAccount }).catch(() => {});
  res.json({ status: 'success' });
}));

app.post('/transfer/bank', auth, h(async (req, res) => {
  await requireEmailVerified(req.uid);
  const { accountNumber, bankCode, amount, pin, idemKey, saveAs } = req.body || {};
  const bankNote = String(req.body?.note || '').trim().slice(0, 60);
  if (!validAmount(amount) || !idemKey || !/^\d{10}$/.test(accountNumber || '') || !bankCode) throw httpErr(400, 'Invalid request');
  await checkPin(req.uid, pin, req.body?.approval);
  const verified = await isVerified(req.uid);
  if (!verified) throw httpErr(403, 'Verify your identity to send money to banks');
  await checkLimit(req.uid, verified, amount);
  const s = await settings();
  const fee = s.bank_fee, pf = s.partner_fee, net = fee - pf;
  const poolPart = Math.floor((net * s.pool_share_bps) / 10000), rev = net - poolPart;
  const idem = `bt:${req.uid}:${idemKey}`;
  const r = await tx(async (c) => {
    const r = await post(c, {
      idem, kind: 'bank_transfer', userId: req.uid, meta: { amount, bankCode, accountNumber, note: bankNote || undefined },
      legs: [
        { account: `u:${req.uid}:main`, amount: -(amount + fee) },
        { account: 'sys:external', amount: amount + pf },
        { account: 'sys:revenue', amount: rev },
        { account: 'sys:pool', amount: poolPart },
      ],
    });
    if (r.duplicate) return r;
    const p = (await c.query(
      `INSERT INTO payouts(idem, user_id, amount, fee, partner_fee, pool_part, rev_part, bank_code, account_number)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [idem, req.uid, amount, fee, pf, poolPart, rev, bankCode, accountNumber])).rows[0];
    await enqueue(c, 'payout', { payoutId: p.id });
    await queueGrant(c, req.uid, 'cashback', idem, Math.floor((fee * s.cashback_of_fee_bps) / 10000));
    await enqueue(c, 'evaluate_bonuses', { userId: req.uid });
    return r;
  });
  if (!r.duplicate) await applyRoundUp({ q, tx, uid: req.uid, amount, idem: `bt:${req.uid}:${idemKey}` });
  if (!r.duplicate) notify(req.uid, 'Bank transfer started',`Your transfer of ${naira(amount)} to account ${accountNumber} is processing. We will email you when it is done.`);
  if (saveAs) await saveBeneficiary(req.uid, { type: 'bank', label: saveAs, accountNumber, bankCode }).catch(() => {});
  res.status(202).json({ status: 'processing', feeKobo: fee, journalId: r.id || null });
}));

// ---------- Flutterwave webhook (deposits + payout results) ----------
// Credits a deposit to the user. Deposits are matched by the email on the virtual account holder.
async function creditDeposit({ reference, userId, email, amount, settled }) {
  const out = await tx(async (c) => {
    const u = userId
      ? (await c.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0]
      : (await c.query('SELECT id FROM users WHERE email=$1', [email || ''])).rows[0];
    if (!u) throw httpErr(404, 'unknown account');
    // Flutterwave keeps its fee. The user is credited what Flutterwave settles (amount minus fee),
    // and the fee goes to sys:revenue so the books still balance.
    const credit = settled == null ? amount : Math.min(amount, settled);
    const fee = amount - credit;
    const r = await post(c, {
      idem: `dep:${reference}`, kind: 'deposit', userId: u.id, meta: { amount, credit, fee, reference },
      legs: fee > 0
        ? [{ account: 'sys:external', amount: -amount }, { account: `u:${u.id}:main`, amount: credit }, { account: 'sys:revenue', amount: fee }]
        : [{ account: 'sys:external', amount: -amount }, { account: `u:${u.id}:main`, amount }],
    });
    if (!r.duplicate) await enqueue(c, 'evaluate_bonuses', { userId: u.id });
    return { r, uid: u.id };
  });
  if (!out.r.duplicate) {
    const credit = settled == null ? amount : Math.min(amount, settled);
    notify(out.uid, 'Money received', `You received ${naira(credit)} in your Legendary Pay wallet. Reference: ${reference}.`);
  }
  return out.r;
}

app.post('/webhooks/flutterwave', h(async (req, res) => {
  const sig = req.get('verif-hash') || '';
  // The sandbox may send no hash; that is only tolerated while SANDBOX=1.
  if (!(sandbox && !sig) && !verifyWebhook(sig)) throw httpErr(401, 'bad signature');
  const { event, data: d = {} } = req.body || {};
  if (event === 'charge.completed' && d.status === 'successful') {
    const amount = Math.round(Number(d.amount) * 100);
    const email = String(d.customer?.email || '').trim().toLowerCase();
    if (!d.id || !(amount > 0) || !email) throw httpErr(400, 'bad payload');
    // amount_settled is what Flutterwave actually pays us after its fee. Missing means no fee taken.
    const settled = d.amount_settled != null && Number.isFinite(Number(d.amount_settled))
      ? Math.round(Number(d.amount_settled) * 100) : null;
    try {
      await creditDeposit({ reference: String(d.id), email, amount, settled });
    } catch (e) {
      if (e.status === 404) await alert(`deposit for unknown account, ref ${d.id}, email ${email}`); else throw e;
    }
  } else if (event === 'transfer.completed') {
    const m = /^payout-(\d+)$/.exec(d.reference || '');
    if (m) {
      const pid = Number(m[1]);
      await settlePayout(pid, d.status === 'SUCCESSFUL' ? 'success' : 'failed');
      const p = (await q('SELECT user_id, amount, status FROM payouts WHERE id=$1', [pid])).rows[0];
      if (p && p.status !== 'queued') {
        const amt = naira(Number(p.amount));
        if (p.status === 'success') notify(p.user_id, 'Bank transfer successful', `Your transfer of ${amt} was successful.`);
        else notify(p.user_id, 'Bank transfer failed', `Your transfer of ${amt} failed. The money has been returned to your wallet.`);
      }
    }
  }
  res.json({ ok: true });
}));

// ---------- app helpers ----------
app.get('/health', h(async (_req, res) => { await q('SELECT 1'); res.json({ ok: true }); })); // for UptimeRobot

app.get('/banks', h(async (_req, res) => {
  const s = await settings();
  res.json({ banks: await listBanks(), bankFeeKobo: s.bank_fee });
}));

app.get('/lookup/wallet', auth, h(async (req, res) => {
  const u = (await q('SELECT id, full_name FROM users WHERE account_number=$1', [String(req.query.account || '')])).rows[0];
  if (!u) throw httpErr(404, 'No wallet found with that number');
  if (u.id === req.uid) throw httpErr(400, 'That is your own wallet');
  res.json({ name: maskName(u.full_name) });
}));

app.get('/lookup/bank', auth, h(async (req, res) => {
  const accountNumber = String(req.query.accountNumber || ''), bankCode = String(req.query.bankCode || '');
  if (!/^\d{10}$/.test(accountNumber) || !bankCode) throw httpErr(400, 'Invalid account');
  res.json({ name: (await resolveBankAccount({ accountNumber, bankCode })).accountName });
}));

app.get('/rewards', auth, h(async (req, res) => {
  const g = (await q(`SELECT status, COALESCE(SUM(amount),0) AS t FROM bonus_grants WHERE user_id=$1 AND status<>'void' GROUP BY status`, [req.uid])).rows;
  const sum = (st) => Number(g.find((x) => x.status === st)?.t || 0);
  const friends = Number((await q('SELECT COUNT(*) AS n FROM users WHERE referred_by=$1', [req.uid])).rows[0].n);
  res.json({ paidKobo: sum('paid'), pendingKobo: sum('pending'), friends });
}));

// ---------- savings goals ----------
// Each goal is its own ledger account. Money moves from main into it and back, so it can never go negative.
app.get('/goals', auth, h(async (req, res) => {
  const r = await q(
    `SELECT g.id, g.name, g.target, COALESCE(a.balance,0) AS saved FROM goals g
     LEFT JOIN accounts a ON a.code = g.account_code WHERE g.user_id=$1 ORDER BY g.id`, [req.uid]);
  res.json(r.rows.map((g) => ({ id: g.id, name: g.name, targetKobo: Number(g.target), savedKobo: Number(g.saved) })));
}));

app.post('/goals', auth, h(async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const target = Number(req.body?.targetKobo);
  if (name.length < 2) throw httpErr(400, 'Give your goal a name');
  if (!Number.isInteger(target) || target < 1000 || target > 500_000_000) throw httpErr(400, 'Target must be between ₦10 and ₦5,000,000');
  const count = Number((await q('SELECT COUNT(*) AS n FROM goals WHERE user_id=$1', [req.uid])).rows[0].n);
  if (count >= 10) throw httpErr(400, 'You can have up to 10 goals');
  await tx(async (c) => {
    const code = `u:${req.uid}:goal:${crypto.randomUUID()}`;
    await c.query(`INSERT INTO accounts(code, user_id, kind) VALUES($1,$2,'goal')`, [code, req.uid]);
    await c.query('INSERT INTO goals(user_id, name, target, account_code) VALUES($1,$2,$3,$4)', [req.uid, name, target, code]);
  });
  res.status(201).json({ ok: true });
}));

// direction: 'in' (main -> goal) or 'out' (goal -> main)
app.post('/goals/:id/move', auth, h(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Goal not found');
  const { amount, direction, pin, idemKey } = req.body || {};
  if (!validAmount(amount) || !idemKey || !['in', 'out'].includes(direction)) throw httpErr(400, 'Invalid request');
  await checkPin(req.uid, pin, req.body?.approval);
  const g = (await q('SELECT account_code FROM goals WHERE id=$1 AND user_id=$2', [req.params.id, req.uid])).rows[0];
  if (!g) throw httpErr(404, 'Goal not found');
  const into = direction === 'in';
  await tx(async (c) => {
    await post(c, {
      idem: `goal:${req.uid}:${idemKey}`, kind: into ? 'goal_deposit' : 'goal_withdraw', userId: req.uid,
      meta: { amount, goal: Number(req.params.id) },
      legs: [
        { account: `u:${req.uid}:main`, amount: into ? -amount : amount },
        { account: g.account_code, amount: into ? amount : -amount },
      ],
    });
  });
  res.json({ ok: true });
}));

// ---------- saved beneficiaries ----------
async function saveBeneficiary(uid, { type, label, accountNumber, bankCode = '' }) {
  const name = String(label || '').trim().slice(0, 40);
  if (!name) return;
  await q(
    `INSERT INTO beneficiaries(user_id, type, label, account_number, bank_code) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`, [uid, type, name, accountNumber, bankCode]);
}

app.get('/beneficiaries', auth, h(async (req, res) => {
  const r = await q('SELECT id, type, label, account_number, bank_code FROM beneficiaries WHERE user_id=$1 ORDER BY label', [req.uid]);
  res.json(r.rows.map((b) => ({ id: b.id, type: b.type, label: b.label, accountNumber: b.account_number, bankCode: b.bank_code })));
}));

app.delete('/beneficiaries/:id', auth, h(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Not found');
  await q('DELETE FROM beneficiaries WHERE id=$1 AND user_id=$2', [req.params.id, req.uid]);
  res.json({ ok: true });
}));

// ---------- airtime (Flutterwave Bills) ----------
const NETWORKS = ['MTN', 'GLO', 'AIRTEL', '9MOBILE'];
app.post('/bills/airtime', auth, h(async (req, res) => {
  await requireEmailVerified(req.uid);
  const { network, phone, amount, pin, idemKey } = req.body || {};
  if (!NETWORKS.includes(network) || !/^0\d{10}$/.test(phone || '') || !validAmount(amount) || !idemKey) {
    throw httpErr(400, 'Invalid request');
  }
  await checkPin(req.uid, pin, req.body?.approval);
  // Our 3% fee is added to the price. The provider is paid the face value only.
  const fee = billFeeKobo(amount);
  const total = amount + fee;
  const reference = `airtime-${req.uid}-${idemKey}`;
  const existing = (await q('SELECT status FROM bill_payments WHERE reference=$1', [reference])).rows[0];
  if (existing) {
    if (existing.status === 'failed') throw httpErr(502, 'Airtime could not be sent. Your money has been returned to your wallet. Try again.');
    return res.json({ status: existing.status, reference });
  }

  // Take the money first, in one transaction with the record. Insufficient balance rolls it all back.
  await tx(async (c) => {
    await c.query(
      `INSERT INTO bill_payments(user_id, reference, network, phone, amount) VALUES($1,$2,$3,$4,$5)`,
      [req.uid, reference, network, phone, amount]);
    await post(c, {
      idem: `bill:${reference}`, kind: 'bill_airtime', userId: req.uid, meta: { amount, fee, network, phone, reference },
      legs: [
        { account: `u:${req.uid}:main`, amount: -total },
        { account: 'sys:external', amount },
        { account: 'sys:revenue', amount: fee },
      ],
    });
  });

  let result;
  try {
    result = await payBill({ reference, customer: phone, amount, network });
  } catch (e) {
    // Unknown outcome: do NOT refund automatically, the provider may have sent it.
    result = { status: 'pending', msg: e.message };
    await alert(`airtime outcome unknown, ref ${reference}: ${e.message}`);
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
    throw httpErr(502, 'Airtime could not be sent. Your money has been returned to your wallet. Try again.');
  }
  await q('UPDATE bill_payments SET status=$2, error=$3 WHERE reference=$1', [reference, result.status, result.msg || null]);
  res.json({ status: result.status, reference });
}));

// ---------- admin tools (all need the admin key) ----------
app.get('/admin/stats', admin, h(async (_req, res) => {
  const s = (await q(`SELECT
     (SELECT COUNT(*) FROM users) AS total_users,
     (SELECT COUNT(*) FROM users WHERE kyc_verified) AS kyc_users,
     (SELECT COUNT(*) FROM users WHERE email_verified) AS email_users,
     (SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind='main') AS held,
     (SELECT COUNT(*) FROM payouts WHERE status='queued') AS queued_payouts,
     (SELECT COUNT(*) FROM bill_payments WHERE status='pending') AS pending_bills,
     (SELECT COUNT(*) FROM journal WHERE created_at >= now() - interval '24 hours') AS tx_24h`)).rows[0];
  // Profit = the balance of sys:revenue (our fees, minus any refunded fees).
  const pr = (await q(`SELECT
     COALESCE(SUM(e.amount),0) AS total,
     COALESCE(SUM(e.amount) FILTER (WHERE j.created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'),0) AS today,
     COALESCE(SUM(e.amount) FILTER (WHERE j.created_at >= date_trunc('week', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'),0) AS week,
     COALESCE(SUM(e.amount) FILTER (WHERE j.created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'),0) AS month
   FROM entries e JOIN accounts a ON a.id = e.account_id JOIN journal j ON j.id = e.journal_id
   WHERE a.code = 'sys:revenue'`)).rows[0];
  const byKind = (await q(`SELECT j.kind, SUM(e.amount) AS total FROM entries e
     JOIN accounts a ON a.id = e.account_id JOIN journal j ON j.id = e.journal_id
     WHERE a.code = 'sys:revenue' GROUP BY j.kind ORDER BY total DESC`)).rows;
  res.json({
    profitKobo: Number(pr.total), profitTodayKobo: Number(pr.today),
    profitWeekKobo: Number(pr.week), profitMonthKobo: Number(pr.month),
    profitByKind: byKind.map((r) => ({ kind: r.kind, kobo: Number(r.total) })),
    totalUsers: Number(s.total_users), kycUsers: Number(s.kyc_users), emailUsers: Number(s.email_users),
    heldKobo: Number(s.held), queuedPayouts: Number(s.queued_payouts),
    pendingBills: Number(s.pending_bills), tx24h: Number(s.tx_24h),
  });
}));

app.get('/admin/users', admin, h(async (req, res) => {
  const term = `%${String(req.query.q || '').trim()}%`;
  const r = await q(
    `SELECT u.id, u.full_name, u.phone, u.email, u.account_number, u.kyc_verified, u.email_verified, u.created_at, u.staff_role,
       COALESCE((SELECT balance FROM accounts a WHERE a.code = 'u:' || u.id::text || ':main'), 0) AS main
     FROM users u
     WHERE $1 = '%%' OR u.phone ILIKE $1 OR u.email ILIKE $1 OR u.full_name ILIKE $1 OR u.account_number ILIKE $1
     ORDER BY u.created_at DESC LIMIT 50`, [term]);
  res.json(r.rows.map((u) => ({
    id: u.id, name: u.full_name, phone: u.phone, email: u.email, accountNumber: u.account_number,
    kycVerified: u.kyc_verified, emailVerified: u.email_verified, createdAt: u.created_at, mainKobo: Number(u.main),
    staffRole: u.staff_role,
  })));
}));

app.get('/admin/payouts', admin, h(async (_req, res) => {
  const r = await q(`SELECT id, user_id, amount, fee, bank_code, account_number, status, created_at
    FROM payouts ORDER BY id DESC LIMIT 50`);
  res.json(r.rows.map((p) => ({
    id: p.id, userId: p.user_id, amountKobo: Number(p.amount), feeKobo: Number(p.fee),
    bankCode: p.bank_code, accountNumber: p.account_number, status: p.status, at: p.created_at,
  })));
}));

app.get('/admin/bill-debug', admin, h(async (_req, res) => {
  res.json(await billDebug());
}));

app.get('/admin/bills', admin, h(async (_req, res) => {
  const r = await q(`SELECT id, user_id, reference, network, phone, amount, status, error, created_at
    FROM bill_payments WHERE status IN ('pending','failed') ORDER BY id DESC LIMIT 50`);
  res.json(r.rows.map((b) => ({
    id: b.id, userId: b.user_id, reference: b.reference, network: b.network, phone: b.phone,
    amountKobo: Number(b.amount), status: b.status, error: b.error, at: b.created_at,
  })));
}));

app.get('/admin/settings', admin, h(async (_req, res) => {
  const r = await q('SELECT key, value FROM settings ORDER BY key');
  res.json(r.rows.map((s) => ({ key: s.key, value: Number(s.value) })));
}));

// ---------- admin ----------
// (profile, receipts, rewards list, goals, beneficiaries, airtime and admin tools live above)
app.post('/admin/kyc/:userId', admin, h(async (req, res) => {
  await q('UPDATE users SET kyc_verified=$2 WHERE id=$1', [req.params.userId, req.body?.verified !== false]);
  await enqueue(null, 'evaluate_bonuses', { userId: req.params.userId });
  res.json({ ok: true });
}));

app.get('/admin/pool', admin, h(async (_req, res) => {
  const bal = await q(`SELECT code, balance FROM accounts WHERE code LIKE 'sys:%'`);
  const pend = (await q(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t FROM bonus_grants WHERE status='pending'`)).rows[0];
  res.json({ system: Object.fromEntries(bal.rows.map((r) => [r.code, Number(r.balance)])), pendingGrants: Number(pend.n), pendingKobo: Number(pend.t) });
}));

app.patch('/admin/settings', admin, h(async (req, res) => {
  const { key, value } = req.body || {};
  if (!Number.isInteger(value) || value < 0) throw httpErr(400, 'bad value');
  const r = await q('UPDATE settings SET value=$2 WHERE key=$1', [key, value]);
  if (!r.rowCount) throw httpErr(404, 'unknown setting');
  res.json({ ok: true });
}));

if (sandbox) {
  app.post('/admin/sim-deposit', admin, h(async (req, res) => {
    const { accountNumber, amount } = req.body || {};
    const u = (await q('SELECT id FROM users WHERE account_number=$1 OR virtual_account=$1', [accountNumber])).rows[0];
    if (!u || !Number.isInteger(amount) || amount <= 0) throw httpErr(400, 'bad request');
    await creditDeposit({ reference: 'sim-' + crypto.randomUUID(), userId: u.id, amount });
    res.json({ ok: true });
  }));
}

mountFeatures(app, { auth, h, q, tx, httpErr, validAmount, checkPin, requireEmailVerified, naira, maskName, notifyUser: notify, settings });
mountSupport(app, { auth, admin: staffOrAdmin, h, q, httpErr, notifyUser: notify, pushStaff: pushToStaff });
mountPush(app, { auth, h, q, httpErr });
mountWebAuthn(app, { auth, h, q, httpErr, sign, notifyUser: notify });
mountTransactions(app, { auth, h, q, httpErr, naira });
mountBills(app, { auth, h, q, tx, post, httpErr, alert, checkPin, requireEmailVerified, validAmount });
mountAccount(app, { auth, h, q, tx, httpErr, checkPin });
mountStaff(app, { auth, h, q, tx, httpErr, notify, naira, isAdminUser, checkPin, enqueue });

app.get('/', (_req, res) => res.json({ ok: true }));

app.use((e, _req, res, _next) => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (INSUFFICIENT(e)) return res.status(402).json({ error: 'Insufficient balance' });
  console.error(e);
  res.status(500).json({ error: 'Server error' });
});

// One process on a free host: the background worker runs inside the API. Set RUN_WORKER=0 to run it separately.
if (process.env.RUN_WORKER !== '0') await import('./worker.js');

app.listen(process.env.PORT || 3000, () => console.log('api up'));
