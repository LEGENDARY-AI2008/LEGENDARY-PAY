// Fingerprint (passkeys / WebAuthn). The fingerprint or face data stays on the user's phone.
// We only store a public key. Used for two things:
//   1. Logging in with fingerprint (no PIN needed).
//   2. Approving money out: any debit can be approved with fingerprint instead of the PIN.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const RP_ID = process.env.WEBAUTHN_RP_ID || 'legendarypayweb.vercel.app';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://legendarypayweb.vercel.app';

// The challenge the phone signed, read from the response the browser sent.
function challengeOf(response) {
  const json = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON || ''), 'base64url').toString('utf8'));
  if (!json.challenge) throw new Error('no challenge');
  return json.challenge;
}

async function saveChallenge(q, challenge, purpose, userId) {
  await q('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  await q(
    `INSERT INTO webauthn_challenges(challenge, purpose, user_id, expires_at)
     VALUES($1, $2, $3::uuid, now() + interval '5 minutes')`, [challenge, purpose, userId]);
}

// A challenge can be used once, and only by the user it was made for.
async function takeChallenge(q, challenge, purpose, userId) {
  const r = await q(
    `DELETE FROM webauthn_challenges
     WHERE challenge=$1 AND purpose=$2 AND user_id IS NOT DISTINCT FROM $3::uuid AND expires_at > now()`,
    [challenge, purpose, userId]);
  return r.rowCount === 1;
}

function storedKey(row) {
  return { id: row.id, publicKey: Buffer.from(row.public_key, 'base64url'), counter: Number(row.counter) };
}

// Used by payments. Returns true, or throws. The approval must be fresh, unused, and from this user.
export async function verifyApproval({ q, httpErr, uid, approval }) {
  const fail = () => httpErr(403, 'Fingerprint check failed. Try again or use your PIN.');
  let a = approval;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { throw fail(); } }
  let challenge;
  try { challenge = challengeOf(a); } catch { throw fail(); }
  if (!(await takeChallenge(q, challenge, 'approve', uid))) throw fail();
  const row = (await q(
    'SELECT id, public_key, counter FROM webauthn_credentials WHERE id=$1 AND user_id=$2', [String(a.id || ''), uid])).rows[0];
  if (!row) throw fail();
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: a, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      credential: storedKey(row), requireUserVerification: true,
    });
  } catch { throw fail(); }
  if (!v.verified) throw fail();
  await q('UPDATE webauthn_credentials SET counter=$2 WHERE id=$1', [row.id, v.authenticationInfo.newCounter]);
  return true;
}

export function mountWebAuthn(app, d) {
  const { auth, h, q, httpErr, sign, notifyUser } = d;

  // ---------- turn fingerprint on for this phone (must be logged in) ----------
  app.post('/webauthn/register/options', auth, h(async (req, res) => {
    const u = (await q('SELECT email, full_name FROM users WHERE id=$1', [req.uid])).rows[0];
    const have = (await q('SELECT id FROM webauthn_credentials WHERE user_id=$1', [req.uid])).rows;
    const options = await generateRegistrationOptions({
      rpName: 'Legendary Pay',
      rpID: RP_ID,
      userName: u.email,
      userDisplayName: u.full_name || u.email,
      userID: new TextEncoder().encode(req.uid),
      attestationType: 'none',
      excludeCredentials: have.map((c) => ({ id: c.id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' },
    });
    await saveChallenge(q, options.challenge, 'register', req.uid);
    res.json(options);
  }));

  app.post('/webauthn/register/verify', auth, h(async (req, res) => {
    const response = req.body?.response;
    let challenge;
    try { challenge = challengeOf(response); } catch { throw httpErr(400, 'Fingerprint setup failed. Try again.'); }
    if (!(await takeChallenge(q, challenge, 'register', req.uid))) throw httpErr(400, 'Fingerprint setup expired. Try again.');
    let v;
    try {
      v = await verifyRegistrationResponse({
        response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
      });
    } catch { throw httpErr(400, 'Fingerprint setup failed. Try again.'); }
    if (!v.verified || !v.registrationInfo) throw httpErr(400, 'Fingerprint setup failed. Try again.');
    const c = v.registrationInfo.credential;
    await q(
      `INSERT INTO webauthn_credentials(id, user_id, public_key, counter, name) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, req.uid, Buffer.from(c.publicKey).toString('base64url'), c.counter, String(req.body?.name || 'This phone').slice(0, 40)]);
    notifyUser(req.uid, 'Fingerprint turned on', 'Fingerprint is now on for one of your phones. If this was not you, change your PIN now.');
    res.status(201).json({ ok: true });
  }));

  // ---------- approve a payment with fingerprint (must be logged in) ----------
  app.post('/approve/options', auth, h(async (req, res) => {
    const have = (await q('SELECT id FROM webauthn_credentials WHERE user_id=$1', [req.uid])).rows;
    if (!have.length) throw httpErr(400, 'Turn on fingerprint in Security first, or use your PIN.');
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'required', allowCredentials: have.map((c) => ({ id: c.id })),
    });
    await saveChallenge(q, options.challenge, 'approve', req.uid);
    res.json(options);
  }));

  // ---------- log in with fingerprint (no account needed up front) ----------
  app.post('/auth/webauthn/login/options', h(async (_req, res) => {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });
    await saveChallenge(q, options.challenge, 'login', null);
    res.json(options);
  }));

  app.post('/auth/webauthn/login/verify', h(async (req, res) => {
    const response = req.body?.response;
    const fail = () => httpErr(401, 'Fingerprint login failed. Use your PIN.');
    let challenge;
    try { challenge = challengeOf(response); } catch { throw fail(); }
    if (!(await takeChallenge(q, challenge, 'login', null))) throw fail();
    const row = (await q(
      'SELECT id, user_id, public_key, counter FROM webauthn_credentials WHERE id=$1', [String(response.id || '')])).rows[0];
    if (!row) throw fail();
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        credential: storedKey(row), requireUserVerification: true,
      });
    } catch { throw fail(); }
    if (!v.verified) throw fail();
    await q('UPDATE webauthn_credentials SET counter=$2 WHERE id=$1', [row.id, v.authenticationInfo.newCounter]);
    res.json({ token: sign(row.user_id) });
  }));
}
