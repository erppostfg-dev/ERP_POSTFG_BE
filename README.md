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

## Structure

```
src/
  config/        env, TypeORM data source
  entities/      TypeORM entities (from PO_Platform_Database_Design)
  migrations/    TypeORM migrations
  middlewares/   error / 404 handlers
  routes/        Express routers
  utils/         ApiError etc.
  app.ts         Express app
  server.ts      DB connect + listen
```

## Adding an API

1. Add the entity in `src/entities/`. Its columns must match the DB design doc.
2. Add a router in `src/routes/`. Its request and response formats must match the API reference.
3. Mount the router in `src/routes/index.ts`.
