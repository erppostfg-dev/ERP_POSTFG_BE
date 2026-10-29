import { loadTestEnv } from './load-env';

// Imported first by test/setup/env.ts: the test settings are in place before any app module reads them.
loadTestEnv();
