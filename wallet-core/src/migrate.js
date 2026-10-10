import fs from 'node:fs';
import { pool } from './db.js';

const sql = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
await pool.query(sql);
console.log('schema ready');
await pool.end();
