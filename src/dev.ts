/*
 * `npm run dev` on the laptop (user, 2026-10-27): laptop mode unless the shell says otherwise, so the laptop never does
 * background work on the database it shares with the dev EC2 (what is switched off: config/env.ts LAPTOP_MODE_OFF).
 * Everything as in .env: `npm run dev:full`. The EC2 runs `node dist/server.js` and never comes here.
 * Set before server.ts loads config/env.ts (dotenv does not overwrite a value that is already set).
 */
process.env.LAPTOP_MODE ??= 'true';
require('./server');
