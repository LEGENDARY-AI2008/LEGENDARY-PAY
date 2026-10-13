import fs from 'node:fs';
import { pool, q } from './db.js';
import { encryptField, decryptField, fingerprint, checkBankKey } from './secure.js';

const sql = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

// Encrypts bank account numbers saved before encryption was added. Safe to run again.
async function encryptExisting() {
  checkBankKey();
  const pays = await q(`SELECT id, account_number FROM payouts WHERE account_number NOT LIKE 'enc1:%'`);
  for (const r of pays.rows) {
    await q('UPDATE payouts SET account_number=$2 WHERE id=$1', [r.id, encryptField(r.account_number)]);
  }
  const bens = await q('SELECT id, account_number FROM beneficiaries WHERE account_hash IS NULL');
  for (const r of bens.rows) {
    const plain = decryptField(r.account_number);
    await q('UPDATE beneficiaries SET account_number=$2, account_hash=$3 WHERE id=$1',
      [r.id, encryptField(plain), fingerprint(plain)]);
  }
  const jr = await q(`SELECT id, meta->>'accountNumber' AS acct FROM journal
    WHERE kind='bank_transfer' AND meta ? 'accountNumber' AND meta->>'accountNumber' NOT LIKE 'enc1:%'`);
  for (const r of jr.rows) {
    await q(`UPDATE journal SET meta = jsonb_set(meta, '{accountNumber}', to_jsonb($2::text)) WHERE id=$1`,
      [r.id, encryptField(r.acct)]);
  }
  console.log(`encrypted: ${pays.rows.length} payouts, ${bens.rows.length} beneficiaries, ${jr.rows.length} transfer records`);
}

try {
  await pool.query(sql);
  console.log('schema ready');
  await encryptExisting();
} finally {
  await pool.end();
}
