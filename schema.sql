CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text UNIQUE NOT NULL,
  email text UNIQUE,
  pin_hash text NOT NULL,
  pin_fails int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  referral_code text UNIQUE NOT NULL,
  referred_by uuid REFERENCES users(id),
  device_id text,
  account_number text UNIQUE,
  kyc_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email text UNIQUE;

-- all money is integer KOBO. Every user has 'main' + 'bonus'. System: pool, revenue, external.
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  user_id uuid REFERENCES users(id),
  kind text NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,
  CHECK (allow_negative OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idem_key text UNIQUE NOT NULL,
  kind text NOT NULL,
  user_id uuid,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_user_kind ON journal(user_id, kind);

CREATE TABLE IF NOT EXISTS entries (
  id bigserial PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES journal(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_account ON entries(account_id);

CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value bigint NOT NULL);

CREATE TABLE IF NOT EXISTS bonus_grants (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,              -- welcome | referral | cashback
  ref text NOT NULL DEFAULT '',
  amount bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',   -- pending | paid | void
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (user_id, type, ref)
);

CREATE TABLE IF NOT EXISTS payouts (
  id bigserial PRIMARY KEY,
  idem text UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  amount bigint NOT NULL,
  fee bigint NOT NULL,
  partner_fee bigint NOT NULL,
  pool_part bigint NOT NULL,
  rev_part bigint NOT NULL,
  bank_code text NOT NULL,
  account_number text NOT NULL,
  status text NOT NULL DEFAULT 'queued',   -- queued | success | refunded
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  attempts int NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  dedupe text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);

INSERT INTO accounts(code, kind, allow_negative) VALUES
  ('sys:pool','pool',true), ('sys:revenue','revenue',true), ('sys:external','external',true)
ON CONFLICT DO NOTHING;

-- amounts in kobo; *_bps = basis points (100 bps = 1%)
INSERT INTO settings(key, value) VALUES
  ('pool_share_bps', 3000),        -- 30% of net fee profit funds the bonus pool
  ('welcome_bonus', 10000),        -- N100
  ('min_deposit', 50000),          -- N500 total deposits to qualify
  ('referral_reward', 10000),      -- N100 to the referrer
  ('referral_monthly_cap', 20),    -- max paid referrals per referrer per 30 days
  ('daily_bonus_cap', 500000),     -- N5,000 total bonuses released per day
  ('cashback_of_fee_bps', 2000),   -- 20% of the fee paid, back as cashback
  ('bank_fee', 5000),              -- N50 charged to user per bank transfer
  ('partner_fee', 2500),           -- N25 your partner charges you
  ('unlock_tx_count', 3)           -- transfers needed before bonus becomes withdrawable
ON CONFLICT DO NOTHING;

-- ===== identity check, funding accounts, PIN reset, limits =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_account text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_bank text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_hash text UNIQUE;

CREATE TABLE IF NOT EXISTS pin_resets (
  email text PRIMARY KEY,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  tries int NOT NULL DEFAULT 0
);

INSERT INTO settings(key, value) VALUES
  ('daily_limit_verified', 50000000),   -- N500,000 per day
  ('daily_limit_unverified', 500000)    -- N5,000 per day (wallet-to-wallet only)
ON CONFLICT DO NOTHING;

-- email verification at signup (6-digit code, 15 minutes, 5 tries)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_tries int NOT NULL DEFAULT 0;
