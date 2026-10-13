// Field encryption for bank account numbers.
// Uses AES-256-GCM with a key from the BANK_KEY environment variable (32 random bytes, base64).
// If BANK_KEY is lost, the stored bank account numbers cannot be read again. Keep a copy somewhere safe.
import crypto from 'node:crypto';

const PREFIX = 'enc1:';

export function checkBankKey() {
  const b = Buffer.from(process.env.BANK_KEY || '', 'base64');
  if (b.length !== 32) throw new Error('BANK_KEY is missing or wrong. It must be 32 random bytes in base64.');
}

function key() {
  checkBankKey();
  return Buffer.from(process.env.BANK_KEY, 'base64');
}

export function encryptField(text) {
  if (text === null || text === undefined || text === '') return text;
  const s = String(text);
  if (s.startsWith(PREFIX)) return s;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
}

export function decryptField(value) {
  if (value === null || value === undefined) return value;
  const s = String(value);
  if (!s.startsWith(PREFIX)) return s; // old plain value, not migrated yet
  const [iv, tag, data] = s.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// Keyed fingerprint so duplicates can be found without storing the number in clear.
export function fingerprint(text) {
  return crypto.createHmac('sha256', key()).update(String(text)).digest('hex');
}
