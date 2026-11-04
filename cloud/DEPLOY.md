# Deploy Impulse Cloud on Google Cloud Run

Step by step, from no cloud account to the desktop app signing in against a
live server. Plan for one to two hours the first time. Everything here fits in
free tiers except the AI itself, which OpenAI bills per use.

What you end up with:

```
Impulse desktop app ──https──▶ Impulse Cloud on Cloud Run (Oregon, us-west1)
                                 ├─▶ Postgres on Neon (AWS Oregon, us-west-2)
                                 ├─▶ OpenAI API (Impulse's key)
                                 └─▶ Resend (sign-up codes, once you own a domain)
```

**Live deployment (2026-10-19).** Already done by Claude with the owner's
go-ahead: project `impulse-cloud-prod` on billing account "My Billing Account
1", Cloud Run service `impulse-cloud` at
https://impulse-cloud-1008821972739.us-west1.run.app, runtime account
`impulse-cloud@impulse-cloud-prod.iam.gserviceaccount.com`, Neon project
`impulse-cloud` (database and owner role `impulse`, smallest compute) in AWS
Oregon, secrets `impulse-database-url`, `impulse-auth-secret`,
`impulse-openai-key`, the image and source cleanup rules from "Running it",
a ₹100 budget with alerts at ₹1, ₹50 and ₹100, and a daily AI spend cap of $2
(admin console → Settings). **Still to do: step 8 (sign-in), which needs the
owner signed in to GitHub as Meet-1010 and to Google as the project's owner**;
`cloud/scripts/set-signin.sh` then does the rest in one command.

**Who does what.** The account steps (Google billing, OAuth apps, OpenAI key,
Resend domain) need you in a browser. Every command step can be run by Claude
in this repository once `gcloud` is signed in, if you prefer: say which.

**Why Oregon, and why it stays free.** The owner wants Impulse Cloud free to
run at launch. Cloud Run, Cloud Build, Artifact Registry and Secret Manager
have the same free allowance in every region, but two allowances apply only
in the US: Cloud Storage (where `--source` deploys upload the code) is free
only in us-east1, us-west1 and us-central1, and Cloud Run's free outbound data
counts only from North America. Neon has a region in Oregon (AWS us-west-2)
within a few milliseconds of Cloud Run's us-west1, which matters because each
AI request makes several database queries. Users in India are farther away
(about 250 ms per round trip instead of 70 ms to Singapore), but OpenAI itself
runs in the US, so an AI answer from Singapore would cross the Pacific anyway:
for the requests that matter the two regions are about equally fast, and only
Oregon is free. If Impulse later outgrows the free tier, Singapore
(`asia-southeast1`) beside Neon's AWS Singapore region is the better home for
non-AI traffic.

---

## Before you start

- A Google account (yours is already signed in to `gcloud` on this Mac).
- A UPI app linked to an Indian bank account, and about ₹1,000 for the
  billing prepayment (it becomes credit for future charges).
- Your Neon account (already used for development).
- An OpenAI account with billing set up.
- A GitHub account.
- Optional now, needed for email sign-up later: a domain name.

What this Mac already has: the Google Cloud CLI (`gcloud`; if a computer lacks
it: `brew install --cask gcloud-cli`), Node 22, and this repository.

---

## 1. Google Cloud: billing with UPI and a project

Your `gcloud` login can see a few projects, the selected project no longer
exists, and the one billing account ("My Billing Account") is **closed**. So:

1. Open <https://console.cloud.google.com/billing>.
   - Either select **My Billing Account** and choose **Reopen** if the console
     offers it, or click **Create account** for a new billing account.
   - Country **India**, currency **INR**, your Indian billing address.
2. **Prepay with UPI** (required before UPI can be used):
   Billing → **Payment overview** → **Make a payment** (or **Pay early**) →
   **Pay with UPI** → amount (Google asks for a prepayment, typically ₹500–1,000)
   → **Continue** → **Pay now** → scan the QR code with your UPI app and approve.
3. **Monthly AutoPay with UPI** so the account never lapses:
   Billing → **Payment method** → **Add payment method** → **Pay with UPI**. It
   appears as an "Other" method: open its drop-down, choose **Primary**, scan
   the QR code and approve the mandate in your UPI app.
   If "Pay with UPI" is not offered, the billing account does not qualify yet
   (Google requires an Indian address and bank account and INR billing).
4. **Create the project**: <https://console.cloud.google.com/projectcreate>
   - Name: `Impulse Cloud`. Project ID: something unique you will type often,
     for example `impulse-cloud-prod` (Google adds digits if it is taken).
   - Billing account: the one from step 1.
5. **A budget alert** (alerts only; it never stops the service):
   Billing → **Budgets & alerts** → **Create budget** → scope: the Impulse
   Cloud project → amount ₹500 per month → alerts at 50 %, 90 % and 100 % →
   email to you.

## 2. Point gcloud at the project and turn on the services

In Terminal, from the repository folder (`~/Impulse-2D-Simulation/repo`):

```bash
export PROJECT_ID=impulse-cloud-prod      # the ID from step 1.4
export REGION=us-west1
gcloud config set project $PROJECT_ID
gcloud config set run/region $REGION
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export SERVICE_URL=https://impulse-cloud-$PROJECT_NUMBER.$REGION.run.app
export RUNTIME_SA=impulse-cloud@$PROJECT_ID.iam.gserviceaccount.com
echo "The server will live at $SERVICE_URL"
```

Keep this Terminal window open: later steps use these variables. (In a new
window, run the block again.)

Turn on Cloud Run, Cloud Build, Artifact Registry and Secret Manager:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com
```

Let Cloud Build build the server (it runs as the project's default compute
account, which needs the Cloud Run Builder role; it takes a minute or two to
apply):

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role=roles/run.builder
```

Create the account the server runs as. Without it, Cloud Run would use the
default compute account, which can change almost anything in the project; this
one can only read the secrets granted to it below:

```bash
gcloud iam service-accounts create impulse-cloud --display-name="Impulse Cloud runtime"
```

## 3. The database on Neon

1. <https://console.neon.tech> → **New project**.
   - Name `impulse-cloud`, Postgres 17, region **AWS US West 2 (Oregon)**.
     The region cannot be changed later.
2. On the project dashboard, **Connect** → turn **Connection pooling** on →
   copy the connection string. It looks like
   `postgresql://…@ep-…-pooler.c-4.us-west-2.aws.neon.tech/impulse?sslmode=require…`
   (the `-pooler` part matters: Cloud Run opens many short connections).
   Change `sslmode=require` to `sslmode=verify-full` and drop
   `channel_binding=require`: the Postgres driver treats `require` as
   `verify-full` today and warns that its next major version will not.
3. Leave it on the clipboard for the next step. Nothing to run here: the
   server creates its tables the first time it starts.

## 4. OpenAI: a production key with a hard monthly cap

1. <https://platform.openai.com> → project picker → **Create project** named
   `Impulse Cloud`.
2. In that project, **API keys** → **Create new secret key** → copy it.
3. Project **Settings** → **Limits** → set a monthly spend limit (say $20 to
   start) and turn on **Enforce a hard limit**: requests fail with HTTP 429
   once it is reached (enforcement is near, not exactly at, the limit). Add
   spend alerts below it.
4. On 2026-10-19 the owner chose to keep using the key from `cloud/.env`
   (it was once pasted into a chat). Rotate it whenever it may have been seen
   by anyone else: create a new key, then
   `pbpaste | gcloud secrets versions add impulse-openai-key --data-file=-`,
   then start a revision that reads it (a secret is read when an instance
   starts, and `services update` refuses to run without a change):
   `gcloud run services update impulse-cloud --region $REGION --update-labels rotated=$(date +%Y%m%d%H%M)`.
   Once the app works, destroy the old version so the free tier's six active
   versions are not exceeded: `gcloud secrets versions list impulse-openai-key`
   shows its number, `gcloud secrets versions destroy N --secret impulse-openai-key`.

Impulse has its own guard as well: a daily spend cap (admin console →
Settings → daily budget, $25 by default) and a per-user request rate.

## 5. Secrets in Secret Manager

Values go from the clipboard straight into Secret Manager, so they never land
in your shell history. Copy each value, then run its line:

```bash
# Neon connection string from step 3 (copy it first):
pbpaste | gcloud secrets create impulse-database-url --data-file=-
# A fresh random sign-in secret (no copying needed):
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create impulse-auth-secret --data-file=-
# The OpenAI key from step 4 (copy it first):
pbpaste | gcloud secrets create impulse-openai-key --data-file=-
```

Let the server's account read them:

```bash
for s in impulse-database-url impulse-auth-secret impulse-openai-key; do
  gcloud secrets add-iam-policy-binding $s \
    --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
done
```

Secret Manager's free tier covers six active secret versions; Impulse uses at
most six (these three, two OAuth secrets, one Resend key). Changing a secret
adds a version: disable the old one in the console afterwards.

## 6. First deploy

From the repository folder:

```bash
gcloud run deploy impulse-cloud \
  --source cloud \
  --region $REGION \
  --service-account $RUNTIME_SA \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --cpu 1 --memory 512Mi --concurrency 80 --timeout 900 \
  --set-env-vars "IMPULSE_CLOUD_URL=$SERVICE_URL,ADMIN_EMAILS=YOUR_EMAIL,IMPULSE_WEBSITE_URL=https://impulse-ide.vercel.app" \
  --set-secrets "DATABASE_URL=impulse-database-url:latest,BETTER_AUTH_SECRET=impulse-auth-secret:latest,OPENAI_API_KEY=impulse-openai-key:latest"
```

- Replace `YOUR_EMAIL` with the Google address you will sign in with; that
  account becomes the admin. gcloud splits `--set-env-vars` on commas, so for
  two admin addresses switch the separator: `--set-env-vars "^;^ADMIN_EMAILS=a@x.com,b@y.com;IMPULSE_CLOUD_URL=$SERVICE_URL;IMPULSE_WEBSITE_URL=https://impulse-ide.vercel.app"`.
- The first run asks to create an Artifact Registry repository for the build:
  answer **Y**.
- `--source cloud` uploads the `cloud/` folder (minus what `.gcloudignore`
  lists, including the local `.env`) and builds it with `cloud/Dockerfile`.
- `--allow-unauthenticated` makes the API public; the server checks every
  request itself. `--max-instances 2` caps how far it can scale (and cost).
  `--timeout 900` keeps long streamed answers alive.

When it finishes it prints **Service URL**. It should equal `$SERVICE_URL`. If
it does not, set the variable to the printed URL and run:
`gcloud run services update impulse-cloud --region $REGION --update-env-vars IMPULSE_CLOUD_URL=$SERVICE_URL`.

## 7. Check that it runs

```bash
curl -s $SERVICE_URL/health          # {"ok":true}
curl -s $SERVICE_URL/v1/config       # the sign-in methods this server offers
gcloud run services logs read impulse-cloud --region $REGION --limit 30
```

The log should show the database tables being created and
`Impulse Cloud on https://… (listening on 0.0.0.0:8080)`.

At this point `/v1/config` lists no sign-in method at all: in production,
email sign-up stays off until a mail service is set up (step 9), and Google
and GitHub come next. Nobody, you included, can sign in before step 8.

## 8. Sign-in with Google and GitHub

**Google**

1. <https://console.cloud.google.com/auth/overview> (Google Auth Platform) in
   the Impulse Cloud project → **Get started**: app name `Impulse`, your support
   email, audience **External**, contact email → **Create**.
2. **Clients** → **Create client** → type **Web application**, name
   `Impulse Cloud` → **Authorized redirect URIs** → add exactly
   `https://impulse-cloud-1008821972739.us-west1.run.app/api/auth/callback/google`
   (print it with `echo $SERVICE_URL/api/auth/callback/google`) → **Create**.
   Copy the **Client ID** and the **Client secret**.
3. **Audience** → **Publish app**. Until it is published, only test users you
   list can sign in. Impulse asks only for name, email and profile picture,
   which need no Google review; adding a logo to the consent screen triggers a
   short brand check (usually minutes).

**GitHub**

1. <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**.
   - Application name `Impulse`; Homepage URL `https://impulse-ide.vercel.app`.
   - Authorization callback URL: `echo $SERVICE_URL/api/auth/callback/github`.
2. **Register application** → **Generate a new client secret**. Copy the
   **Client ID** and the secret.

**Give them to the server.** The quick way: copy the client secret, then run
`cloud/scripts/set-signin.sh github <client-id>` (or `google <client-id>`). It
stores the secret from the clipboard, lets the server read it, sets the client
ID and prints the sign-in methods the server now offers. By hand (copy each
secret right before its line):

```bash
pbpaste | gcloud secrets create impulse-google-secret --data-file=-   # Google client secret
pbpaste | gcloud secrets create impulse-github-secret --data-file=-   # GitHub client secret
for s in impulse-google-secret impulse-github-secret; do
  gcloud secrets add-iam-policy-binding $s \
    --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
done
gcloud run services update impulse-cloud --region $REGION \
  --update-env-vars "GOOGLE_CLIENT_ID=PASTE_GOOGLE_CLIENT_ID,GITHUB_CLIENT_ID=PASTE_GITHUB_CLIENT_ID" \
  --update-secrets "GOOGLE_CLIENT_SECRET=impulse-google-secret:latest,GITHUB_CLIENT_SECRET=impulse-github-secret:latest"
```

`services update` starts a new revision with the same image; no rebuild.

**Try it in a browser**: open `$SERVICE_URL/sign-in/`, sign in with Google,
then open `$SERVICE_URL/admin/`. Your account is the admin because its address
is in `ADMIN_EMAILS`. In the admin console, look at **Settings** before anyone
else signs in: the daily budget (spend cap for the whole service), the welcome
bonus (200 credits by default, worth up to $2 of AI per new account), the
request rate, and the **Routing** table (which model does which kind of work).

## 9. Email codes with Resend (when you own a domain)

Email sign-up sends a 6-digit code, which needs a mail service with a verified
sending domain. Resend's shared test sender only delivers to your own address.

1. Buy a domain at any registrar (a `.in` or `.com`).
2. <https://resend.com> → **Domains** → **Add domain** → add the DNS records it
   shows at your registrar → wait for **Verified**.
3. **API Keys** → **Create API key** (sending access) → copy it.
4. Store it and switch email sign-up on:

```bash
pbpaste | gcloud secrets create impulse-resend-key --data-file=-
gcloud secrets add-iam-policy-binding impulse-resend-key \
  --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
gcloud run services update impulse-cloud --region $REGION \
  --update-env-vars "EMAIL_FROM=Impulse <hello@YOUR-DOMAIN>" \
  --update-secrets "RESEND_API_KEY=impulse-resend-key:latest"
```

Resend's free plan sends 100 emails a day and 3,000 a month; enough for
sign-up codes at launch. `/v1/config` now shows `email: true`.

## 10. Point the desktop app at the server and release

This part is code, so Claude can do it once you share the service URL:

1. Set `"impulse": { "cloudUrl": "<SERVICE_URL>" }` in the root `package.json`.
2. `npm run install:mac` to replace the app on this Mac, sign in with Google,
   and ask the AI something: the answer is billed to your account.
3. Bump the version and push a tag like `v2.0.0-beta.3`: GitHub Actions
   builds the installers into a draft release, which you review and publish.
   The website's download links follow `RELEASE` in `website/src/main.ts`.

The released app talks to `cloudUrl` forever, so pick the final address before
the first public release (see "A custom domain" below).

---

## Running it

**Update the server** after code changes (keeps all settings and secrets):

```bash
gcloud run deploy impulse-cloud --source cloud --region $REGION
```

New database migrations run when the new revision starts.

**Roll back**: Cloud Run → impulse-cloud → **Revisions** → **Manage traffic**
→ send 100 % to the previous revision. Or:
`gcloud run services update-traffic impulse-cloud --region $REGION --to-revisions PREVIOUS_REVISION=100`.

**Logs**: Cloud Run → impulse-cloud → **Logs**, or
`gcloud run services logs read impulse-cloud --region $REGION --limit 100`.

**Keep old builds from piling up** (Artifact Registry is free up to 0.5 GB,
and each deploy adds an image). Keep the newest three:

```bash
cat > /tmp/impulse-cleanup.json <<'EOF'
[
  { "name": "keep-newest-3", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 3 } },
  { "name": "delete-the-rest", "action": { "type": "Delete" }, "condition": { "olderThan": "1d" } }
]
EOF
gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy \
  --location $REGION --policy /tmp/impulse-cleanup.json --no-dry-run
```

**Cold starts**: with `--min-instances 0` the server sleeps when idle and the
first request after a quiet spell waits a few seconds, and Neon's free compute
also sleeps after 5 minutes idle. When users notice, set
`--min-instances 1` (billed while idle at a lower rate) and consider Neon's
paid plan.

**What costs money** (check Billing → Reports now and then):

| Service | Free allowance | Impulse at launch |
|---|---|---|
| Cloud Run | 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests and 1 GB of outbound data from North America a month | well inside |
| Cloud Build | 2,500 build-minutes a month | a deploy takes about 3 minutes |
| Cloud Storage | 5 GB in us-west1 (uploaded sources) | inside; sources expire after 7 days |
| Artifact Registry | 0.5 GB | inside, with the cleanup policy |
| Secret Manager | 6 active secret versions, 10,000 reads | inside |
| Neon | free plan: 0.5 GB storage, limited compute hours (Impulse uses the smallest compute) | inside |
| Resend | 100 emails a day | inside |
| OpenAI | none | the real cost, capped by the server's daily budget ($2 at first) and OpenAI's hard limit |

## A custom domain (later)

`us-west1` supports Cloud Run domain mappings (a preview feature):
verify the domain once (`gcloud domains verify YOUR-DOMAIN`), then
`gcloud beta run domain-mappings create --service impulse-cloud --domain api.YOUR-DOMAIN --region $REGION`
and add the DNS records it prints. Then set `IMPULSE_CLOUD_URL` to the new
address, add its `/api/auth/callback/google` and `/api/auth/callback/github`
URLs to both OAuth apps, and release the app with the new `cloudUrl`. Do this
before the first public release if you can.

## When something goes wrong

| Symptom | Cause and fix |
|---|---|
| Deploy fails with `PERMISSION_DENIED` mentioning `run.builder` | The role from step 2 has not applied yet (wait two minutes) or was not granted. |
| Deploy fails: secret … permission denied | Step 5's `add-iam-policy-binding` was skipped for that secret. |
| `/health` fails, logs say `Set DATABASE_URL…` | A secret is empty or misnamed: `gcloud secrets versions access latest --secret impulse-database-url \| head -c 30`. |
| Logs show database connection errors | The Neon string must be the **pooled** one with `sslmode=verify-full` (or `require`). |
| Google says `redirect_uri_mismatch` | The redirect URI in step 8 must match `$SERVICE_URL/api/auth/callback/google` exactly, `https` included. |
| Only some Google accounts can sign in | The OAuth app is still in Testing: Audience → Publish app. |
| The app says Impulse AI is unavailable | `OPENAI_API_KEY` is missing or revoked, or the OpenAI hard limit was reached: admin console → Settings → This server, and the OpenAI project's usage page. |
| Answers stop mid-stream after 15 minutes | That is `--timeout 900`; raise it (up to 3600). |
