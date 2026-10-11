# wallet-core

Node + Postgres wallet backend: double-entry ledger, bonus pool, referrals, cashback, identity check,
funding accounts, bank payouts, PIN reset by email, daily limits. All money is integer kobo.
One process runs the API and the background jobs.

## Run locally
    cp .env.example .env     # fill DATABASE_URL, JWT_SECRET, ADMIN_KEY
    npm install
    npm run migrate
    npm start

## Deploy on Render
1. Push this folder to GitHub. Render > New > Web Service. Build `npm install`, start `npm start`.
2. Add a Postgres database (Render, Neon, or Supabase) and put its URL in DATABASE_URL (PGSSL=1 if it needs SSL).
3. Set the env vars from .env.example. Run `npm run migrate` once in the Render Shell.
4. Your API address is the URL Render shows (https://<name>.onrender.com). Put it in wallet-app.html as API_BASE,
   and put the app's own address in ALLOWED_ORIGIN.

## Keep it awake (UptimeRobot, free)
Free Render services sleep after about 15 minutes without traffic. In UptimeRobot add a monitor: type HTTP(s),
URL `https://<name>.onrender.com/health`, interval 5 minutes. This also alerts you if the API goes down.
Check Render's current free-hours limit; one always-on free service normally fits inside it.

## Frontend on Vercel
The app lives in the separate wallet-web folder (plain static files, no build step). Deploy it on Vercel, then set
ALLOWED_ORIGIN here to the Vercel address (for example https://your-app.vercel.app) and redeploy.

## Connect Monnify (when you are ready)
1. Create a Monnify account. In the dashboard, Developer > API Keys & Contracts: copy the API key, secret key, contract code.
2. Dashboard > Disbursements: copy your wallet account number (MONNIFY_SOURCE_ACCOUNT) and turn OFF transfer 2FA/OTP,
   otherwise automatic payouts will wait for a manual code.
3. Set the webhook URL for transactions and disbursements to  https://<name>.onrender.com/webhooks/monnify
4. Fill the MONNIFY_* variables. Keep MONNIFY_BASE_URL on the sandbox URL until tested.
5. Going live: set SANDBOX=0, MONNIFY_BASE_URL=https://api.monnify.com, use live keys. The server refuses
   SANDBOX=1 together with the live URL. Check every endpoint in src/monnify.js against developers.monnify.com first.

## How it works
- Sign up (phone, email, PIN) > "Verify identity" (full name + BVN or NIN) > Monnify creates a personal funding account.
  Only a keyed fingerprint of the ID is stored, so one ID cannot open several wallets.
- Deposits arrive by webhook and credit the ledger. Bank sends are paid out by the worker; a failed payout refunds in full.
- Bonuses come only from the pool (30% of fee profit), FIFO, under a daily cap. Empty pool = bonuses wait.
- Unverified users: wallet-to-wallet only, N5,000/day. Verified: bank sends, N500,000/day. Change limits and bonus
  amounts any time: PATCH /admin/settings with header x-admin-key.

## Sandbox test (SANDBOX=1, no Monnify keys needed)
    curl -XPOST $API/auth/signup -H 'content-type: application/json' -d '{"phone":"08011112222","email":"a@b.com","pin":"1234","deviceId":"d1"}'
    curl -XPOST $API/admin/sim-deposit -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' -d '{"accountNumber":"8011112222","amount":100000}'
    curl $API/admin/pool -H "x-admin-key: $ADMIN_KEY"

## Still to do before real users
CAC registration and Monnify go-live approval, terms and privacy pages, backups, a paid always-on server.
