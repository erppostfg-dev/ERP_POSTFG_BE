# POST_FG

PO platform backend — Node.js, Express, TypeScript, TypeORM, MySQL.

## Setup

```bash
npm install
cp .env.example .env   # fill in DB credentials
npm run dev            # http://localhost:3000/api/v1
```

- Health: `GET /api/v1/health`

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run with auto-reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run typecheck` | Type-check only |
| `npm run migration:generate -- src/migrations/<Name>` | Generate migration from entity changes |
| `npm run migration:run` / `migration:revert` | Apply / roll back migrations |

## Email intake by Gmail label (Pub/Sub)

```
Gmail filter -> label (e.g. Po-Intake) -> users.watch -> Pub/Sub topic -> pull subscription
  -> this server: history.list -> every new email with a routed label
  -> POST <label's endpoint> (multipart: files, from, subject, messageId, label, body)
  -> POST /api/v1/po-intake/email saves it to storage/emails/<label>/<received date>_<key>/
```

- **Routes:** `src/modules/email-intake/label-routes.ts` maps each label name to an endpoint. Every email that gets the label is sent, with all its attachments.
- **Start it:** set `PUBSUB_ENABLED=true`, `GCP_PROJECT_ID`, `PUBSUB_TOPIC` and `PUBSUB_SUBSCRIPTION` in `.env`, then run `npm run dev`.
  - The server starts the Gmail watch and renews it every 24 hours.
  - The Gmail OAuth token must include the Pub/Sub scope, so run `npm run gmail:token` again after upgrading.
- **On every start, the listener catches up by itself:**
  1. **First time a label is watched:** every email already in it is sent (one-time backfill).
  2. **After a stop:** everything that changed since the last run is sent, through Gmail history.
  3. **Safety net:** the label's emails since the last sync are listed, and any not sent yet are sent.
- **New emails** are then sent a few seconds after they're labelled (Pub/Sub).
- **Where progress is kept:** `storage/gmail-state.json` holds the last `historyId`, the last sync time, the backfilled labels and the Gmail ids already sent. Nothing is downloaded twice.
- **Manual backfill (optional):** with the server running, `npm run email:route -- --label Po-Intake [--max N]` sends the emails in a label to its endpoint.
- **`POST /api/v1/po-intake/email`:**
  - Needs the `X-Webhook-Secret` header (`WEBHOOK_SECRET`). Takes multipart `files` (0–10, 20 MB each), plus `from`, `subject`, `messageId`, `label`, `receivedAt`, `bodyText` and `bodyHtml`.
  - Returns `202 { data: { messageId, label, duplicate, status, folder, attachments } }`.
  - The same `messageId` is stored once.

## Structure

```
src/
  config/        env, TypeORM data source
  entities/      TypeORM entities (from PO_Platform_Database_Design)
  migrations/    TypeORM migrations
  middlewares/   error / 404 handlers
  modules/email-intake/  Gmail client, label routes, Pub/Sub listener, storage
  routes/        Express routers (health, po-intake)
  scripts/       gmail:token, email:route
  utils/         ApiError etc.
  app.ts         Express app
  server.ts      DB (optional) + listen + email listener
```

## Adding an API

1. Add the entity in `src/entities/`. Its columns must match the DB design doc.
2. Add a router in `src/routes/`. Its request and response formats must match the API reference.
3. Mount the router in `src/routes/index.ts`.
