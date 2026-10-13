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

-- ===== savings goals, saved beneficiaries, airtime bill payments =====
CREATE TABLE IF NOT EXISTS goals (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  target bigint NOT NULL,
  account_code text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,                 -- wallet | bank
  label text NOT NULL,
  account_number text NOT NULL,
  bank_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, account_number, bank_code)
);

CREATE TABLE IF NOT EXISTS bill_payments (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  reference text UNIQUE NOT NULL,
  network text NOT NULL,
  phone text NOT NULL,
  amount bigint NOT NULL,
  status text NOT NULL DEFAULT 'processing',   -- processing | success | pending | failed
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== notifications, money requests, reminders, check-ins, budgets, schedules, round-up =====
CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  body text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);

CREATE TABLE IF NOT EXISTS money_requests (
  id bigserial PRIMARY KEY,
  from_user uuid NOT NULL REFERENCES users(id),   -- the one asking for money
  to_user uuid NOT NULL REFERENCES users(id),     -- the one who should pay
  amount bigint NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',         -- pending | paid | declined
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminders (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  amount bigint NOT NULL DEFAULT 0,
  due_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkins (
  user_id uuid NOT NULL REFERENCES users(id),
  day date NOT NULL,
  streak int NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS budgets (
  user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL,
  limit_kobo bigint NOT NULL,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS schedules (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,                 -- transfer | save
  label text NOT NULL DEFAULT '',
  amount bigint NOT NULL,
  frequency text NOT NULL,            -- weekly | monthly
  to_account text,
  goal_id bigint,
  next_run timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS roundup_goal bigint;

-- Live chat support
CREATE TABLE IF NOT EXISTS support_threads (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_threads_user ON support_threads(user_id, status);
CREATE TABLE IF NOT EXISTS support_messages (
  id bigserial PRIMARY KEY,
  thread_id bigint NOT NULL REFERENCES support_threads(id),
  sender text NOT NULL CHECK (sender IN ('user','admin')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_thread ON support_messages(thread_id, id);
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS image text;

-- Fingerprint (passkeys): only public keys are stored, never fingerprint data
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user ON webauthn_credentials(user_id);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge text PRIMARY KEY,
  purpose text NOT NULL,
  user_id uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL
);

-- account deletion: deleted users keep their money records but cannot sign in
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- support staff: role on the user, a system account for balance adjustments, and an audit log
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role text;
INSERT INTO accounts(code, kind, allow_negative) VALUES ('sys:adjust','adjust',true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS staff_audit (
  id bigserial PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_user_id uuid REFERENCES users(id),
  amount_kobo bigint,
  reason text NOT NULL,
  ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_audit_created ON staff_audit(created_at);

-- broadcast emails: users who clicked unsubscribe
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_out boolean NOT NULL DEFAULT false;

-- web push: one row per device (browser) a user allowed; app_kv keeps the VAPID keys if not set in env
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS app_kv (key text PRIMARY KEY, value text NOT NULL);

-- repeating bills: the worker pays each one on its next date from the user's wallet
CREATE TABLE IF NOT EXISTS bill_schedules (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL,
  biller text NOT NULL,
  item text NOT NULL,
  plan_name text,
  customer text NOT NULL,
  amount_kobo bigint,
  every_days int NOT NULL,
  next_run timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bill_schedules_due ON bill_schedules(active, next_run);

-- bill cashback: share of the bill amount paid back to the user (200 = 2%, i.e. N2 per N100)
INSERT INTO settings(key, value) VALUES ('bill_cashback_bps', 200) ON CONFLICT (key) DO NOTHING;

-- keyed fingerprint of saved account numbers (duplicate checks without storing the number in clear)
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS account_hash text;
CREATE INDEX IF NOT EXISTS beneficiaries_hash ON beneficiaries(user_id, type, account_hash, bank_code);

-- one BVN/NIN may now open up to 3 wallets (checked in code), so the fingerprint is no longer unique
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kyc_hash_key;
CREATE INDEX IF NOT EXISTS users_kyc_hash ON users(kyc_hash);
