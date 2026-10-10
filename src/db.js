import 'dotenv/config';
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
});
export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function settings(c = pool) {
  const r = await c.query('SELECT key, value FROM settings');
  return Object.fromEntries(r.rows.map((x) => [x.key, Number(x.value)]));
}
