import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import routes from '../../src/routes';
import { ROOT } from '../setup/load-env';
import { coveredEndpoints, listRoutes } from '../helpers/routes';

/*
 * The API inventory (2026-10-28, user: "if we change an API the tests must tell what else to change"):
 *   1. routes.json = every endpoint the app has. Adding / removing / renaming one fails here with a to-do list
 *      (API_REFERENCE.md, the frontend's endpoint constants + api/*.ts types, tests); then `npm run routes:update`.
 *   2. Every endpoint must be tested: named in a test file's covers([...]), or still listed in untested.json while the
 *      suite is being built. A NEW endpoint cannot be added to untested.json silently (it fails until it has tests or
 *      the list is updated on purpose), and a covered one must be taken off the list (it only shrinks).
 * Ajay's in-transit endpoints (/intransit/...) are listed but not required to have tests yet (user: our code first).
 */
const FILE = path.join(ROOT, 'test/meta/routes.json');
const UNTESTED = path.join(ROOT, 'test/meta/untested.json');
const NOT_OURS = /^[A-Z]+ \/intransit\//;

const current = listRoutes(routes);
const read = (f: string): string[] => (fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as string[]) : []);
if (process.env.UPDATE_ROUTES === '1') fs.writeFileSync(FILE, `${JSON.stringify(current, null, 2)}\n`);

describe('API inventory', () => {
  it('matches test/meta/routes.json (every endpoint change is deliberate)', () => {
    const known = read(FILE);
    const added = current.filter((r) => !known.includes(r));
    const removed = known.filter((r) => !current.includes(r));
    if (added.length || removed.length) {
      throw new Error([
        'The API changed:',
        ...added.map((r) => `  + ${r}`),
        ...removed.map((r) => `  - ${r}`),
        'Do all of these, then run `npm run routes:update`:',
        '  1. API_REFERENCE.md: add / update / remove the endpoint (use, access, request, response, errors)',
        '  2. POST_FG_FE: endpoint constant (src/constants/*.ts) + request / response types (src/api/*.ts) + every screen that calls it',
        '  3. tests: covers([...]) + access / validation / happy path / side effects (test/api/...)',
        '  4. related endpoints that read or write the same data (lists, history, re-checks) still agree',
      ].join('\n'));
    }
    expect(added).toEqual([]);
  });

  it('every endpoint of ours has tests (or is still on test/meta/untested.json)', () => {
    const covered = coveredEndpoints();
    const untested = read(UNTESTED);
    const ours = current.filter((r) => !NOT_OURS.test(r));
    const missing = ours.filter((r) => !covered.has(r) && !untested.includes(r));
    const nowCovered = untested.filter((r) => covered.has(r));
    const gone = untested.filter((r) => !current.includes(r));
    const unknownCovers = [...covered].filter((r) => !current.includes(r));
    const problems = [
      ...missing.map((r) => `  no tests: ${r} (add a test with covers(['${r}']))`),
      ...nowCovered.map((r) => `  tested now, remove from untested.json: ${r}`),
      ...gone.map((r) => `  no such endpoint any more, remove from untested.json: ${r}`),
      ...unknownCovers.map((r) => `  covers() names an endpoint that does not exist: ${r}`),
    ];
    if (problems.length) throw new Error(`API test coverage:\n${problems.join('\n')}`);
    // progress, printed for the person running the tests
    console.log(`API tests: ${ours.length - untested.length} of ${ours.length} endpoints covered, ${untested.length} still to do`);
  });
});
