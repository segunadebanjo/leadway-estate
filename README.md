# Leadway Estate – Association Management App

Residents' portal, executive dashboard and gate app for Leadway Estate, Mowe, Ogun State. Replaces the Excel ledger with a PostgreSQL-backed web app.

**Stack:** Node.js 20+ (Express 5) · Prisma 6 · PostgreSQL · React 19 (Vite) · Paystack · Termii (SMS) · SMTP (email)

```
server/   REST API, billing scheduler, Paystack webhook, Prisma schema + migration, tests
client/   React single-page app (admin dashboard, resident portal, security gate)
```

## Online or on your own computer?

**Want a link that everyone can open?** See [Put it online (free)](#put-it-online-free-your-own-web-address-in-about-15-minutes). **Just trying it out alone?** Run it on your computer (next section).

## Easiest way: run it on your own computer

You need one thing installed: **Node.js** (the "LTS" version from https://nodejs.org). No database or Docker to install; a database is built in.

1. Get the code: on GitHub click **Code → Download ZIP**, then unzip it (or `git clone` it).
2. Double-click the start file in the folder:
   * **Windows:** `Start Leadway Estate (Windows).bat`
   * **Mac:** `Start Leadway Estate (Mac).command`. The first time, macOS may block it: right-click it, choose **Open**, then **Open** again.
   * Or, in a terminal in the folder: `npm run local`
3. The first time it downloads what it needs, which takes a few minutes and needs internet. It then asks if you want sample data to try things out, and opens the app in your browser at **http://localhost:4000**.
4. Sign in with the details it shows. They are also saved in `local-data/FIRST-SIGN-IN.txt`. You'll choose your own password straight away.

Keep the black window open while you use the app; close it (or press Ctrl+C) to stop. Next time, double-click again: it starts in seconds and everything you entered is still there.

**Your data** lives in the `local-data` folder. To back it up, stop the app and copy that folder somewhere safe. Don't delete it unless you want to start again from empty.

Other people on the same Wi-Fi can use it at `http://<this computer's IP address>:4000` while it's running. To put it on the internet, see "Deploying online" below.

## Removing the sample data

If you loaded the sample residents to try the app, sign in as admin. The **Dashboard** then shows a
"Sample data is loaded" box. Click **Remove sample data** and confirm. It deletes the 12 sample residents,
the sample gate login (gate@example.com) and everything that belongs to them: their bills, payments,
requests and visitor passes, plus the sample expenses and store items. Anything you entered yourself is kept.
New members are then numbered straight on from your highest real one.

## Adding many members at once (Excel upload)

On **Residents**, press **Upload members**:

1. Click **Download the Excel template** and fill it in, one member per row (first name, last name and email are required; phone, plot, street, owner/tenant and move-in date are optional). Your own spreadsheet also works if its first row names the columns; common names such as "Surname", "Mobile" or "House No" are recognised.
2. Choose the file (.xlsx or .csv) and press **Check file**. Nothing is saved yet: you see who will be added, who is already in the app (skipped), and which rows need fixing.
3. Press **Add**. Each new member gets a membership ID and a temporary password and is billed for the current month, exactly as with **Add member**. **Download the sign-in details** straight away: the passwords are shown only once.

Uploading the same file twice adds nobody twice. **Expenses** has the same **Upload expenses** button for loading past spending. **Download list** on Residents saves the member register for Excel.

## Setting up email

Email (sign-in details, "Forgot password", receipts, reminders) needs an email service. Render's free plan blocks ordinary SMTP, so the app uses **Brevo** (free, 300 emails a day) over HTTPS:

1. Sign up at brevo.com with the address the estate should send from.
2. In Brevo: your name (top right) → **SMTP & API** → **API Keys** → **Generate a new API key**; copy it.
3. In Render → leadway-estate → **Environment**, add `BREVO_API_KEY` (the key) and `EMAIL_FROM` = `Leadway Estate <the address you signed up with>`, then **Save, rebuild, and deploy**.
4. In the app, **Settings → Send a test email**.

On your own server any SMTP account works instead (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`).

## Billing members for the year (debit notes)

1. Under **Ledger → Fee types**, check the **annual due** amount and add a **Security Fee** (frequency *Monthly*) if it is not there.
2. Open **Debit notes → Issue debit notes**. Pick the year, the annual due and the security fee (amounts can be changed for this year only), the months (January to December), the date on the note and the pay-by date, and type the estate bank details to print on the note.
3. Click **Check before issuing** to see each member's total, then **Issue**. Members get a notice (and an email if email is set up).

Every payment is taken off the member's oldest bills first, so it nets off the debit note with no extra steps. A new member joining mid-year can be given their own note from their member page (**Issue debit note**, starting from the month they join). The monthly billing never charges a month that is already on a debit note.

## Getting updates (after changes are made)

Your data lives in the `local-data` folder, so updating the program never touches it.

**With GitHub Desktop (recommended):** install [GitHub Desktop](https://desktop.github.com), choose
*File → Clone repository* → `segunadebanjo/leadway-estate` once. After that, to get changes:
close the app window, click **Fetch origin** then **Pull origin**, and double-click the Start file again.

**With the ZIP:** stop the app, download the new ZIP, unzip it, and copy the old `local-data` folder
into the new folder before double-clicking Start. (Forget this step and you start with an empty app.)

Either way, the Start file notices what changed: it installs new packages, updates the database
tables and rebuilds the website by itself.

## Quick start for developers

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
| **Bank statement upload** | *Receive Payment → Upload bank statement*: the estate account statement from internet banking (Excel/CSV) as it is. Money-in lines are matched to members by a Membership ID column, "LWE 12" in the narration, phone number or name, then received exactly like a manual payment. A bank reference is used once, so re-uploading never double-counts |
| **Reminders** | List of everyone with overdue bills; send a reminder now by app notice, email and SMS; or switch on **weekly automatic reminders** (day, minimum days overdue, minimum amount). Nobody is reminded more than once a week; members keeping up with a payment plan are skipped |
| **Debit notes (annual billing)** | Once a year, one debit note per member: the annual due plus the security fee for January to December (or from a later month for new members), due all at once or month by month. Each line is an ordinary bill, so every payment (cash, transfer, POS, online, bank-statement upload, account credit) nets off the note automatically. Printable note with payments taken off and balance due; issue to everyone or one member; check before issuing; never bills twice; cancel and re-issue if nothing is paid |
| **Statement of account** | Per member, with opening balance, running balance, debit notes as one line each, and Print / PDF and CSV. Members see their own; executives see it on the member's page and under Reports |
| **Payment plans** | Spread a member's debt over 2–24 monthly instalments. The plan is measured against cash paid since it was agreed (bills still settle oldest first), shows each instalment as paid / part paid / overdue, completes itself when paid, and appears on the member's home page |
| **Meetings & polls** | Polls for all residents, owners or tenants: one vote per member, results shown when voting closes. Meetings with agenda and notice to residents, and an attendance register (with proxies), turnout and CSV download |
| **Household & vehicles** | Residents list the people who live with them and their cars (*My household*); executives see and edit them on the member's page. The gate's **Check a car or person** finds who a plate or name belongs to |
| **Settings** | Shows whether email, SMS and Paystack are set up, step-by-step email set-up with Brevo, and *Send a test email* |
| **Uploads** | Members, expenses, assets and bank statements from Excel/CSV, each with a template, a check-first preview and duplicate protection |
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

## Put it online (free): your own web address in about 15 minutes

When this is done, the app has a permanent link such as **https://leadway-estate.onrender.com**. You,
the other executives and the residents open it on any phone or computer, each with their own sign-in,
and everyone sees the same records. You need two free accounts. Neither asks for a card.

**Step 1: Make the database (Neon, about 5 minutes)**
1. Go to **neon.tech** and click **Sign up**. Choosing **Continue with GitHub** is easiest.
2. Create a project. Name it `leadway-estate` and choose the region **Europe (Frankfurt)**.
3. On the project page, click **Connect**, then the **Copy** button next to the connection string.
   It starts with `postgresql://`. Paste it into a note for a moment. You can copy it however Neon
   shows it, pooled or not; the app tidies it up itself.

**Step 2: Make the website (Render, about 10 minutes)**
1. Go to **render.com** and sign up with **GitHub**. When GitHub asks, allow Render to see `leadway-estate`.
2. Click this button:

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/segunadebanjo/leadway-estate)

   (Or in Render: **New** → **Blueprint** → choose `leadway-estate`.)
3. Render shows three boxes. Fill them in:
   * **DATABASE_URL**: paste the Neon string from Step 1.
   * **SEED_ADMIN_EMAIL**: your email. This is your sign-in.
   * **SEED_ADMIN_PASSWORD**: a temporary password. You choose your own at first sign-in.
4. Click **Deploy Blueprint** (or **Apply**) and wait about 5 minutes, until it says **Live**.
5. Click the address at the top of the page (`https://leadway-estate….onrender.com`) and sign in.

That's it. Add your members under **Residents**, then share the address with them.

**Good to know**
* **First visit of the day is slow.** A free app sleeps after 15 minutes without visitors, and the next
  visitor waits about a minute while it wakes. Nothing is lost: billing catches up when it wakes. To keep
  it awake, create a free job at **cron-job.org** that opens `<your address>/health` every 10 minutes.
* **When I make changes,** Render updates the online app by itself within a few minutes. There is
  nothing for you to download. Your records are in Neon and are kept.
* **Later, when you are ready:** add Paystack keys (online payments), email (SMTP) and SMS (Termii)
  in Render → your service → **Environment**. Then, in the Paystack dashboard, set the webhook URL to
  `<your address>/api/payments/webhook` and do one test payment with your `sk_test_` keys first.
* **Your own domain** (e.g. `app.leadwayestate.ng`): Render → **Settings** → **Custom Domains**.
* **Free limits:** Neon's free tier has 0.5 GB, which is years of estate records. Download a backup now
  and then (Neon → **Backup & Restore**).

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
