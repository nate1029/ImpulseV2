# Impulse Cloud

The server behind Impulse's accounts and credits: sign-in (Google, GitHub,
email + password with an emailed code), the credit ledger and plans, the AI
gateway that pays for every user's Claude requests from Impulse's own key, the
admin console, and the hand-off that signs the desktop app in through the
browser. One [Hono](https://hono.dev) app (`src/app.js`) on Postgres, deployed
on Vercel with zero configuration from `src/index.js`; `public/` is served as
static files.

| Path | What |
|---|---|
| `/sign-in/` | The web sign-in page (also used by the desktop app for Google and GitHub) |
| `/admin/` | The admin console: overview, users, upgrade requests, settings, audit log |
| `/api/auth/*` | Better Auth (sign-in, sign-up, codes, sessions) |
| `/ai/v1/messages` | The AI gateway: Anthropic's Messages API, authenticated with an Impulse session, charged in credits |
| `/v1/config`, `/v1/me`, `/v1/models`, `/v1/usage`, `/v1/plans`, `/v1/upgrade-request` | What the app reads about the account |
| `/desktop/complete`, `/desktop/token` | Browser sign-in → desktop app (one-time code + PKCE) |
| `/admin/api/*` | The console's API (admins only, audited) |

## Run it on your computer

You need Node 22+ and a Postgres (Homebrew: `brew install postgresql@16`, or
Docker: `docker run -p 55432:5432 -e POSTGRES_USER=impulse -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16`).

```bash
cd cloud
npm install
cp .env.example .env          # set DATABASE_URL and BETTER_AUTH_SECRET at least
npm run dev                   # migrates, then serves http://localhost:8787
```

Without `RESEND_API_KEY`, email codes are printed to the server log, which is
fine for development. With `OPENAI_API_KEY` set, the GPT models work locally
(and cost real money, so keep `dailyBudgetUsd` low). Without any vendor key
you can still exercise the whole flow with the stand-in Anthropic API:

```bash
node scripts/fake-anthropic.js          # http://127.0.0.1:8799
# .env: ANTHROPIC_BASE_URL=http://127.0.0.1:8799  ANTHROPIC_API_KEY=anything
node --env-file=.env scripts/seed-demo.js   # demo users and usage for the console (local databases only)
```

Point the desktop app at it from the repository root:

```bash
IMPULSE_CLOUD_URL=http://localhost:8787 npm run dev
```

Every address in `ADMIN_EMAILS` becomes an admin once it signs in with a
verified email; the console is at `/admin/`.

## The admin console

`/admin/` has five pages: **Overview** (users, active users, paid plans,
today's upstream spend against the daily cap, open upgrade requests, request
and cost charts, cost by model, top users), **Users** (search, plan, credits,
grants, suspend, sign out everywhere), **Upgrade requests** (approve or decline
Pro/Max requests until a payment provider is connected), **Settings** (welcome
credits, credits per dollar and markup, each plan's name, credits per period,
refill period in hours or a calendar month, price and models; the enabled and
default models; rate limit and daily budget; maintenance mode and an
announcement; "This server" lists what is configured) and the **Audit log**.

To reach it:

1. Add your address to `ADMIN_EMAILS` (comma-separated) in the server's
   environment (Vercel › Settings › Environment Variables for production; the
   `.env` file for a local server) and restart or redeploy.
2. Open `<cloud URL>/sign-in/?next=/admin/` and sign in with that address:
   Google, GitHub, or an email account you create there (the code arrives by
   email in production; a local server prints it to its log as
   `[email] … code for …`). The address must be verified: Google and GitHub
   addresses are, an email account is once its code is entered.
3. You land on `/admin/`. The role is granted on that first verified sign-in
   and stays; signing out and back in is not needed later. Admin writes carry
   an `x-impulse-admin` header and a same-origin `Origin`, and every change is
   written to the audit log.

Locally, with Postgres on `127.0.0.1:55432` and `cd cloud && npm run dev`,
that is `http://localhost:8787/sign-in/?next=/admin/`.

## Credits and refills

Each plan has an allowance per period (`monthlyCredits`) and a period:
`periodHours` for plans that refill every few hours, or empty for a calendar
month. The defaults give the **Free** plan 25 credits every 5 hours plus the
200 welcome credits that never expire; **Pro** and **Max** refill monthly. A
refill happens lazily, on the first request after the period ends (an hourly
plan's clock then restarts from that request); nothing runs on a schedule.
Unused plan credits do not roll over; a small overdraft from a request that
cost more than was left is repaid from the next refill. The app shows "refills
in 2 h 10 min" for hourly plans and the date for monthly ones. Change any of
this on the Settings page.

## Tests

```bash
cd cloud && npm test
```

`test/` runs against a scratch database (`TEST_DATABASE_URL`, default
`postgres://impulse@127.0.0.1:55432/impulse_test`), **dropping and recreating
its `public` schema** each run, with a fake Anthropic API on a local port. CI
runs the same suite against a Postgres service (job "Impulse Cloud").

## Routing: one Impulse AI

People never see a model name. Before each turn the app calls
`POST /v1/route` with the kind of work (`agent`, `plan`, `debug`, `ask`,
`summary`) and how many times that turn has already failed (`escalate`); the
server answers with the model to use, chosen from the admin console's
**Routing** table among the models this server can serve on the account's
plan. The defaults are the cheapest model that does the job per kind, with
`gpt-5.5` as the escalation step. A vendor without a key is never chosen.

## Deploy on Google Cloud Run (free tier)

The production target. **[DEPLOY.md](DEPLOY.md)** is the full walkthrough:
billing with UPI, the project, Neon in Singapore, an OpenAI key with a hard
cap, Secret Manager, the deploy command, Google and GitHub sign-in, Resend,
pointing the app at the server, updates, rollbacks and costs.

In short: the container is `cloud/Dockerfile` (`.gcloudignore` keeps the local
`.env` out of the upload), the server listens on `HOST`/`PORT`, migrates the
database when it starts, and reads every secret from the environment. Cloud
Run and the database share a region (`asia-southeast1` with Neon's AWS
Singapore), because each AI request makes several database queries before the
first token streams.

## Deploy on Vercel

1. **Database**: a Neon project (or any Postgres). Use the pooled connection
   string with `sslmode=require` as `DATABASE_URL`.
2. **Vercel project** with the root directory `cloud` (framework detected as
   Hono, Node 22). Environment variables, all from `.env.example`:
   - `DATABASE_URL`, `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)
   - `IMPULSE_CLOUD_URL` — the public URL of this deployment (OAuth redirects
     and sign-in links use it)
   - `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` — Impulse's own keys; every
     user's requests on that vendor's models are paid from them. A vendor
     without a key is not offered. Set a spending limit in each vendor's
     console too; the gateway's daily budget is a second guard.
   - `ADMIN_EMAILS` — comma-separated addresses that become admins
   - `RESEND_API_KEY` and `EMAIL_FROM` — codes by email (verify the sending
     domain in Resend first)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — a "Web application" OAuth
     client whose authorized redirect URI is
     `<IMPULSE_CLOUD_URL>/api/auth/callback/google`
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — an OAuth App whose callback
     URL is `<IMPULSE_CLOUD_URL>/api/auth/callback/github`
   - `IMPULSE_WEBSITE_URL` — where `/` redirects
   Sign-in methods without credentials are simply not offered.
3. **Migrate**: the Vercel function never changes the schema. From your
   computer, against the production database:
   ```bash
   DATABASE_URL='postgres://…' BETTER_AUTH_SECRET='…' npm run migrate
   ```
   (`migrate` creates Better Auth's tables, then applies `migrations/*.sql`
   once each; it is safe to run again.)
4. **Streaming**: long answers stream for minutes. In the Vercel project
   settings, raise the function maximum duration (300 s is a good value).
5. **Point the app at it**: set `"impulse": { "cloudUrl": "https://…" }` in the
   repository's `package.json` and ship a release. Builds with `cloudUrl: null`
   have no AI (the simulator and IDE still work); `IMPULSE_CLOUD_URL`
   overrides the build's value for development.
6. Sign in on `/sign-in/` with an admin address, open `/admin/`, and check
   "This server" on the Settings page: it lists what is configured.

## How credits work

- 1 credit = 1 cent of Anthropic's list price for the request (input, output,
  cache reads and cache writes), multiplied by the **markup** setting; every
  charge rounds up to at least a thousandth of a credit, so no request is free.
- New accounts get **welcome credits** (200) once their email is verified
  (Google and GitHub addresses arrive verified). Plans: Free 100 credits a
  month, Pro 1,500 ($20), Max 6,000 ($60); Fable 5.1 needs Pro or Max. All of
  it is editable in the console's Settings without a deploy.
- Plan credits are spent first and refill each monthly period (unused ones
  don't roll over); bonus credits (welcome, granted, bought) never expire. A
  request that costs more than what is left runs the plan a little negative,
  repaid at the next refill.
- Upgrades are **requests** the team approves in the console until a payment
  provider is connected; approving one moves the account to the plan with a
  fresh month.

## Guards

Sessions are bearer tokens (the app stores its token encrypted with the OS
credential store). Browser sign-in for the app uses a one-time code bound to a
PKCE challenge, redeemed only on `127.0.0.1`. Admin writes need an
`x-impulse-admin` header and a same-origin `Origin`, and every change is in the
audit log. The gateway forwards known request fields only, refuses server-side
tools, caps `max_tokens`, limits requests to 6 MB and 40 a minute per user,
pauses for everyone when the day's upstream spend reaches the daily budget,
and never shows users an error about Impulse's own key.
