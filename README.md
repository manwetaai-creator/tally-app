# Manweta AI - FastAPI + Neon + Azure

Same product, same UI, new backend. The dashboard (`static/`) is the original `public/assets` **byte-for-byte**;
only `server.ts` (Express, in-memory) was replaced by FastAPI + Neon Postgres + Azure Blob.

```
app/            FastAPI (routers/auth|portal|connector|webhook, models, blob, reminders, seed)
static/         original UI (index.html, assets/app.js, styles.css, logos)
Dockerfile      python:3.12-slim + gunicorn/uvicorn on :8000
deploy/azure-deploy.sh, .github/workflows/deploy-azure.yml
tests/test_smoke.py
```

## Run locally
```bash
cp .env.example .env            # set ENCRYPTION_KEY (command inside the file)
docker compose up --build       # app :8000 + a throw-away Postgres
# or: pip install -r requirements.txt && DATABASE_URL=postgresql://... uvicorn app.main:app --reload
```
Log in with the demo account `demo@manweta.ai` / `password123` (seeded when `SEED_DEMO_DATA=true`).
Tables are created on startup. Tests: `DATABASE_URL=postgresql://... python -m pytest tests -q`.

## Neon
Create a project, copy the **pooled** connection string (host contains `-pooler`) into `DATABASE_URL`
(`?sslmode=require` included). The app forces the psycopg3 driver, disables server-side prepared statements for PgBouncer,
and uses `pool_pre_ping` so Neon's scale-to-zero wake-up doesn't surface as errors.

## Deploy to Azure
```bash
az login
export DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require'
./deploy/azure-deploy.sh
```
Creates: resource group, Container Registry (image built in Azure with `az acr build`), private Storage container
`installers`, Linux App Service plan (B1) + Web App for Containers, system-assigned identity with `AcrPull`,
`Storage Blob Data Contributor` and `Storage Blob Delegator` (so no keys or SAS secrets live in app settings),
Always On, health check on `/health`. Secrets are written once to `deploy/.secrets.env` (git-ignored) - **back it up**;
losing `ENCRYPTION_KEY` means every client must reconnect WhatsApp.
Then point Meta's webhook at `https://<app>.azurewebsites.net/api/v1/whatsapp/webhook`.
For CI/CD set repo variables `ACR_NAME`, `WEBAPP_NAME` and secrets `AZURE_CLIENT_ID/TENANT_ID/SUBSCRIPTION_ID` (OIDC).

## What stays identical
Every endpoint, request/response shape and error message the UI uses; demo data; reminder rules (overdue / due-soon,
repeat gap, minimum amount, customer-wise vs bill-wise); STOP/START opt-out; activation code -> API key flow;
installer download/upload/config screens.

## What changed on purpose
| Area | Before | Now |
|---|---|---|
| Storage | in-memory (lost on restart) | Neon Postgres |
| Sessions | in-memory | `sessions` table (token stored hashed) |
| Passwords | SHA-256 + fixed salt | argon2 |
| WhatsApp token | plaintext | Fernet-encrypted (`ENCRYPTION_KEY`); never returned by the API |
| Installer | local disk (`public/blobs`) | Azure Blob, private, served via 15-min read-only SAS redirect |
| Webhook | routed by "first tenant" fallback | routed by `phone_number_id`; unattributable messages dropped; out-of-order statuses can't downgrade `read`; signature enforced when `META_APP_SECRET` is set |

## Known gaps carried over from the original (decide before real customers)
1. **Password reset is open.** The UI sends only email + new password, so anyone can reset any account. Kept for UI parity
   behind `INSECURE_PASSWORD_RESET=true` (logged as a warning at boot). Setting it to `false` disables the screen until an emailed-link flow is built.
2. **Any logged-in user can replace the Windows installer** that every tenant downloads. Set `INSTALLER_ADMIN_EMAILS` to lock it down.
3. **WhatsApp sending is still simulated** (messages are marked `delivered`; nothing goes to Meta, and Embedded Signup / template approval are faked).
   The single seam is `send_whatsapp_reminder()` in `app/reminders.py`.
4. **No scheduler** - "automatic reminders" settings are stored but nothing runs them daily (also true of the original).
5. **Sync never closes paid bills** - an invoice that disappears from Tally stays "outstanding" and keeps getting reminders.
6. Demo seed uses dates relative to first boot; set `SEED_DEMO_DATA=false` in production.
