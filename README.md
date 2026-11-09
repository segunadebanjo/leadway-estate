# Leadway Estate – Association Management App

Residents' portal, executive dashboard and gate app for Leadway Estate, Mowe, Ogun State. Replaces the Excel ledger with a PostgreSQL-backed web app.

**Stack:** Node.js 20+ (Express 5) · Prisma 6 · PostgreSQL · React 19 (Vite) · Paystack · Termii (SMS) · SMTP (email)

```
server/   REST API, billing scheduler, Paystack webhook, Prisma schema + migration, tests
client/   React single-page app (admin dashboard, resident portal, security gate)
```

## Quick start (development)

Prerequisites: Node 20+, PostgreSQL 14+ (or Docker).

```bash
docker compose up -d                 # optional: local Postgres on :5432
npm run install:all
cp server/.env.example server/.env   # then edit: JWT_SECRET, PAYSTACK_SECRET_KEY, …
npm run db:migrate                   # applies the migration
npm run db:seed                      # fee types + first admin (password printed once)
npm --prefix server run db:demo      # optional: 12 demo residents, bills, payments, assets
npm run dev:server                   # API on :4000
npm run dev:client                   # app on :5173 (proxies /api to :4000)
```

Sign in at http://localhost:5173 with the seeded admin. Admin-created accounts get a temporary password and must choose their own at first sign-in. Demo residents use the password `Resident123`; `gate@example.com` is a security-staff account.

## Roles

| Role | Can do |
|---|---|
| **Admin** (executives) | Everything below, plus members, money, assets, reports, broadcasts, audit log |
| **Resident** | Own bills, Pay now, receipts, statement, visitor passes, requests, documents, notifications. Billed automatically |
| **Security** | Gate only: verify visitor codes, check in / out. Never billed |

Roles are re-read from the database on every request, so deactivation, role changes and password resets take effect immediately.

## What's included

| Area | Features |
|---|---|
| **Residents** | Create / edit / deactivate / reactivate, owner vs tenant, temp-password issue & reset (optionally emailed), outstanding balance and credit per member. Every member gets a unique **Membership ID** (`LWE-0001`, …) from a database sequence; it cannot be edited and is searchable everywhere (`LWE-0007`, `0007` or `7`) |
| **Receive Payment** | Pick a member, enter amount, method (cash / transfer / POS), date, reference. Allocated to unpaid bills oldest-first (or a chosen bill first) with a live preview; any excess becomes **account credit**, applied automatically to future bills. One e-receipt per payment listing every bill it settled |
| **Ledger** | Invoices & payments with filters, **payment reversal** (cheque bounced, entered twice), **void** an untouched invoice, assign one-off fees to chosen residents or everyone (optional label stops double-billing), fee types, manual credit adjustments |
| **Expenses** *(new)* | What the association spends, by category, feeding the Income & Expenditure report |
| **Assets** | Equipment & consumables, quantity moved only through a movement log (used / restocked / relocated / stock count + where deployed), maintenance log with cost, low-stock alerts |
| **Reports** | Collections (cash actually received, by method / fee / month), Outstanding & ageing (not due, 1–30, 31–60, 61–90, 90+), Billing vs collection, **Income & expenditure**, Member statement (running balance), Assets register, Member register. Print / PDF and **CSV for Excel** (formula-injection safe) |
| **Documents** | Upload PDF / Word (checked by content, not name), categorise, residents download |
| **Broadcast** | In-app notice + optional email + SMS to everyone, owners, tenants or chosen residents; delivery counts |
| **Requests** *(new)* | Residents report faults / complaints by category; executives are notified, update status with a note; the resident is notified (and emailed when resolved) |
| **Visitor gate passes** *(new)* | Resident issues a 6-digit one-time code (optionally texted to the visitor) valid for a set window; security verifies, checks in (once only) and out; the resident is notified on arrival |
| **Audit log** *(new)* | Every executive action on members, money and records, with before/after values |
| **Resident portal** | Outstanding / overdue / paid / credit, itemised bills, **Pay now** (full or part, ≥ ₦100), receipts, statement, visitor passes, requests, documents, notifications, own phone number |
| **Accounts** | **Self-service password reset** by emailed one-hour single-use link *(new)*; change password signs out other devices |

### Billing rules
* **Monthly Due ₦5,000** is billed to every active resident for the current month. **Annual Development Fee ₦40,000** is billed in January (`ANNUAL_BILLING_MONTH`). A resident who joins later in the year isn't charged that year's annual fee automatically (assign it by hand if your rules say otherwise). Both are seeded as fee types; changing an amount in *Ledger → Fee types* affects future invoices only.
* Bills fall due `PAYMENT_TERMS_DAYS` (14) after the 1st.
* The scheduler runs nightly at 00:10 (Africa/Lagos) and at boot. It is **idempotent**: there is a unique key on `userId + feeType + period`, and concurrent runs share one pass. *Dashboard → Run billing now* does the same on demand. A new or reactivated resident is billed for the current period straight away.
* Admins and security staff are never billed. Deactivated residents are not billed but keep their history.
* Any account credit a member holds is applied to a new bill the moment it is raised.

### The money model
* Amounts are **integer kobo** everywhere (no floating point). Database CHECKs stop negative money and over-settled invoices.
* Every payment, from any channel, goes through **one allocation engine** (`server/src/services/ledger.js`). It locks the member's row, so simultaneous receipts, webhooks and credit applications for one member are serialised.
* `Invoice.amountPaid` always equals its live allocations, and `User.creditBalance` always equals the sum of the `CreditEntry` ledger. The test suite checks both after every scenario.
* A reversal restores the bills and takes back any credit the payment created. If that credit has already paid other bills, the reversal is refused until those credit receipts are reversed first.

### Payments (Paystack)
1. The resident clicks **Pay now** → `POST /api/payments/initialize`. The *server* sets or caps the amount (the bill's balance, or everything outstanding; part-payments allowed, never more than is owed) and creates the Paystack transaction. The browser only gets an access code and opens the popup (`@paystack/inline-js`: card / bank / transfer / USSD). If the popup can't open, it falls back to Paystack's hosted page and `/pay/callback`.
2. Paystack calls **`POST /api/payments/webhook`** (`charge.success`). The server checks the `x-paystack-signature` HMAC-SHA512 over the raw body, **re-verifies the transaction server-to-server**, checks currency and our own metadata, then credits the member through the allocation engine (chosen bill first; if it was settled meanwhile, the money settles other bills or becomes credit, so nothing is lost) and emails the e-receipt.
3. After the popup closes the browser also calls `GET /api/payments/verify/:reference` as a fallback (needed on localhost, where Paystack can't reach the webhook). Webhook, callback and Paystack retries are all safe: a reference is applied at most once.

**Go-live checklist:** set `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` (live keys) and register `https://<your-domain>/api/payments/webhook` in Paystack Dashboard → Settings → API Keys & Webhooks.

## Security notes
* Session in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Every state-changing request must carry `X-Requested-With: fetch` (CSRF defence; the client adds it).
* Login, password reset and forgot-password are rate-limited. An unknown email and a wrong password get the same answer and take the same time.
* Passwords are hashed with bcrypt. Reset tokens are stored only as SHA-256 hashes.
* Uploads are checked by magic bytes, stored under random names, and served as attachments with `nosniff`.
* Helmet sets a CSP that allows only Paystack's script and checkout frames.

## Deploying online for free (Render + Neon)

Nothing here needs a paid plan. The app runs on **Render's free web plan**, the database on **Neon's free PostgreSQL** (Render's own free database is deleted after 30 days, Neon's is not), and uploaded documents are stored in the database, so no disk is needed.

**1. Create the database on Neon**
1. Sign up at neon.tech (GitHub sign-in works). Create a project named `leadway-estate`, region **AWS Europe Central (Frankfurt)**.
2. On the project dashboard click **Connect**, turn **Connection pooling off**, and copy the connection string. It looks like `postgresql://neondb_owner:…@ep-….eu-central-1.aws.neon.tech/neondb?sslmode=require`. If it ends with `&channel_binding=require`, delete that part.

**2. Create the app on Render**
1. Sign up at render.com with your GitHub account and allow it to see `leadway-estate`.
2. **New → Blueprint**, pick this repo, then **Apply**. Render asks once for:
   * `DATABASE_URL`: the Neon string from step 1.
   * `APP_URL`: `https://leadway-estate.onrender.com` (Render shows the exact address; correct it later if it differs).
   * `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`: the first executive's sign-in. The password is temporary and must be changed at first sign-in.
   * Paystack, SMTP and Termii keys. These can be left blank and added later under **Environment**.
3. The first build takes a few minutes. It builds the website, creates the tables and the first admin. Open the address and sign in, then delete `SEED_ADMIN_PASSWORD` from **Environment**.

**3. Keep it awake (recommended, free)**
A free Render app goes to sleep after 15 minutes without visitors, and the next visitor waits about a minute while it wakes. To avoid that, and so the nightly billing runs on time, create a free job at cron-job.org that opens `https://<your-app>.onrender.com/health` every 10 minutes. One app running all month fits within Render's free hours. Even without this, nothing is lost: billing catches up whenever the app wakes.

**4. Before taking real payments**
In the Paystack dashboard set the webhook URL to `<APP_URL>/api/payments/webhook`, and do one test payment with your `sk_test_` keys first.

Pushing to `main` redeploys automatically. Your own domain can be added under Settings → Custom Domains (then update `APP_URL`).

**Free-plan limits.** Neon's free tier has 0.5 GB of storage. That is plenty for years of estate records, but keep documents to PDFs of normal size (each upload is limited to 10 MB). Neon keeps a short restore history; for safety, download a backup now and then (Neon → Backup & Restore, or `pg_dump`). If the estate outgrows the free tiers, upgrade the same Render service and Neon project. Nothing needs to move.

## Production deployment (your own server)

```bash
npm run install:all && npm run build   # builds client/dist
npm run db:migrate
npm run db:seed                        # first time only
NODE_ENV=production npm start          # API also serves client/dist on one origin
```
* Put it behind HTTPS (nginx / Caddy / a PaaS). The API trusts one proxy hop for client IPs.
* Set `APP_URL` to the public URL, a long random `JWT_SECRET`, and SMTP / Termii credentials.
* **Back up** the database. Uploaded documents are stored in it, so a database backup covers everything.
* If you run several API instances, set `ENABLE_SCHEDULER=false` on all but one. Billing is idempotent, so extra schedulers are safe but wasteful.
* `GET /health` checks the database for load-balancer probes.

## Tests

```bash
# needs an empty Postgres database whose name contains "test" (it is wiped!)
DATABASE_URL=postgresql://user:pass@localhost:5432/leadway_test npm test
```
55 end-to-end API tests run against real Postgres with Paystack stubbed. They cover:
* auth: sign-in, CSRF header, forced password change, reset link single-use, sign-out everywhere, role isolation
* members: unique membership IDs (including concurrent creation), search
* billing: idempotency, concurrent runs, the annual fee, who is billed, credit auto-applied
* payments: oldest-first allocation, chosen invoice, overpayment credit, duplicate references, simultaneous receipts, reversals, voids, receipt privacy
* Paystack: server-set amount, webhook signature, replay and concurrency, failed / wrong-currency / unknown references, part-payments, money landing on a bill already settled
* features: uploads, broadcasts, asset movements, gate passes, requests, expenses
* reports: reconciliation with the dashboard, member balances and statements, CSV injection

CI runs them on every push (`.github/workflows/ci.yml`) and builds the client.

## Changes from the original README / version 1
* Rebuilt from the README spec. The original `server/` and `client/` sources were not available.
* One receipt per payment (listing each bill it settled) instead of one per invoice.
* Online payments use the same allocation engine as office payments, so online part-payments work and an overpayment race becomes credit instead of a note.
* New: payment reversal, invoice void, credit adjustments, expenses + income & expenditure report, service requests, visitor gate passes with a Security role, audit log, self-service password reset, `/health`, demo data, CI.

## Known limits / next steps
* Verified with Paystack **stubbed**. Before going live, do an end-to-end test with your `sk_test_…` key and a public tunnel (e.g. ngrok) for the webhook. SMTP and Termii likewise need real credentials to confirm delivery.
* Online payments cannot be reversed in the app. Refund them in Paystack and record a negative credit adjustment.
* No PDF generation on the server: receipts and reports print to PDF from the browser.
