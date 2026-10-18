# Cabby

Ride booking app: Next.js frontend, FastAPI API, PostgreSQL on Supabase, and Stripe Checkout. Email delivery is not configured.

## Features

- Rider and driver accounts with role-based API access
- Address suggestions, route/fare estimates, and map display
- Ride booking, driver acceptance, live GPS polling, arrival OTP, cancellation, and history
- Stripe Checkout with signed webhook confirmation; local development has an explicit simulated payment mode
- Ride reviews

## Local setup

1. Create a Supabase project, then apply every SQL file in `supabase/migrations/` in filename order using Supabase SQL Editor.
2. Set up backend:

   ```sh
   cd backend
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env
   uvicorn main:app --reload
   ```

3. Set up frontend in another terminal:

   ```sh
   cd frontend
   cp .env.local.example .env.local
   npm ci
   npm run dev
   ```

4. Open `http://localhost:3000`; API docs live at `http://localhost:8000/docs`.

For local SQLite, leave `SUPABASE_DATABASE_URL` empty. For Supabase, set it to the Session pooler connection string. `TOKEN_SECRET` must be a long random value outside local development.

## Stripe payments

1. Create a Stripe account and use test mode first.
2. Set backend `STRIPE_SECRET_KEY` to test secret key and `FRONTEND_URL` to frontend origin.
3. Start local API, then forward Stripe events:

   ```sh
   stripe listen --forward-to localhost:8000/api/webhooks/stripe
   ```

4. Copy CLI webhook secret into backend `STRIPE_WEBHOOK_SECRET`. Subscribe endpoint to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.expired` (also `payment_intent.succeeded` is supported).
5. Complete ride as driver, then pay from rider History. Stripe confirms payment only after signed webhook verifies ride, INR currency, and exact fare.
6. For production, use live Stripe keys and a deployed webhook URL. Set backend `APP_ENV=production`; missing Stripe config then blocks checkout rather than marking ride paid in demo mode.

## Deploy

### Database

Apply all migrations to production Supabase in filename order. Use the Session pooler URL as `SUPABASE_DATABASE_URL`; keep database credentials server-side. API connects with SQLAlchemy, so Supabase RLS does not replace API authorization.

### API on Render

Create Blueprint from `render.yaml`. Set:

- `SUPABASE_DATABASE_URL`
- `CORS_ORIGINS` to exact Vercel origin, no trailing slash
- `FRONTEND_URL` to Vercel origin
- `MAPS_USER_AGENT` with a real contact address
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `APP_ENV=production`

Render generates `TOKEN_SECRET`. Configure Stripe webhook to `https://<render-host>/api/webhooks/stripe`.

### Frontend on Vercel

Import repo, set Root Directory to `frontend`, and set `NEXT_PUBLIC_API_URL` to Render API origin. Redeploy after setting it because Next.js embeds this value at build time.

## Before launch

- Apply latest migration, configure Stripe live keys/webhook, and verify a successful payment plus expired checkout in Stripe dashboard.
- Deploy API and frontend; verify CORS, health endpoint, registration/login, booking, driver completion, payment, history, and review flows.
- Replace public Photon/OSRM services with contracted providers before meaningful traffic; current providers have public-use limits and no uptime guarantee.
- Set backup/restore policy for Supabase and review Stripe webhook delivery logs.
- Email receipts, phone verification, password reset, driver identity/vehicle approval, refunds, promotions/wallet, Redis, WebSockets, Celery, and automated test suite remain future work. Email intentionally left out per request.
