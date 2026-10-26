/*
 * Channel API connectors by hand (2026-10-16). Reads the channel's API (GET only) and our DB; writes only with --apply.
 *
 *   npm run amazon:check [-- --days 30] [-- --ids FBA15A,FBA15B]
 *       DRY RUN: what changed, what each PO would do (ready / waiting / skipped / exists) and, for the ready ones,
 *       whether it would pass or go to review and why. Nothing is written, the check point is not touched.
 *   npm run amazon:pull -- --ids FBA15A,FBA15B [--apply]
 *       Those POs through the full chain (S3, po_uploads, PO tables, sale order, Uniware CSV; review when they fail).
 *       Without --apply: the same dry run for those ids. The check point is not touched (the scheduler owns it).
 *
 * Generic form: ts-node src/scripts/channel-api.ts <check|pull> <connector key> [options]
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { ERROR_CODES } from '../constants';
import { connectorOf, CONNECTORS } from '../modules/channel-api/registry';
import { runConnector } from '../modules/channel-api/runner';
import { appError } from '../utils/AppError';

const [, , mode, key] = process.argv;
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const USAGE = 'channel-api <check|pull> <connector> [--days N] [--ids a,b] [--max N] [--apply]';

const main = async () => {
  const c = connectorOf(key ?? '');
  if (!c) throw appError(ERROR_CODES.CONNECTOR_UNKNOWN, String(key), CONNECTORS.map((x) => x.key).join(', '));
  if (mode !== 'check' && mode !== 'pull') throw appError(ERROR_CODES.CLI_USAGE, USAGE);
  if (!c.configured()) throw appError(ERROR_CODES.CLI_USAGE, `${c.label}: keys missing in .env`);
  const ids = arg('ids')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (mode === 'pull' && !ids?.length) throw appError(ERROR_CODES.CLI_USAGE, 'pull needs --ids (the scheduler takes everything else)');
  const days = Number(arg('days') ?? 30);
  const apply = mode === 'pull' && APPLY;

  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(`${c.label}: ${apply ? 'APPLY' : 'DRY RUN (nothing is written)'} -> ${AppDataSource.options.database}`);
  try {
    const { items, since, until } = await runConnector(c, {
      apply,
      ids,
      since: ids ? undefined : new Date(Date.now() - days * 864e5),
      max: arg('max') ? Number(arg('max')) : undefined,
    });
    if (!ids) console.log(`changed between ${since.toISOString()} and ${until.toISOString()}: ${items.length}`);
    const order = { ready: 0, exists: 1, waiting: 2, skipped: 3 } as const;
    for (const i of [...items].sort((a, b) => order[a.decision] - order[b.decision])) {
      const verdict = i.result
        ? `-> ${i.result}${i.saleOrder ? `, sale order ${i.saleOrder}` : ''}${i.error ? `, ERROR ${i.error}` : ''}`
        : i.error ? `ERROR ${i.error}`
        : i.decision === 'ready' ? (i.wouldPass ? 'WOULD PASS' : `WOULD GO TO REVIEW: ${(i.reasons ?? []).join(' | ')}`)
        : '';
      console.log(`${i.decision.padEnd(8)} ${i.externalId.padEnd(14)} ${i.status.padEnd(13)} ${(i.lines ?? '').toString().padStart(3)} lines  ${i.label}  ${verdict}`);
    }
    const ready = items.filter((i) => i.decision === 'ready');
    // After --apply say what was done; a dry run says what would happen.
    const done = (r: string) => ready.filter((i) => i.result === r).length;
    const verdicts = apply
      ? `completed ${done('completed')}, review ${done('needs_review')}, failed ${ready.filter((i) => i.error).length}`
      : `pass ${ready.filter((i) => i.wouldPass).length}, review ${ready.filter((i) => i.wouldPass === false).length}`;
    console.log(`\nready ${ready.length} (${verdicts}) · ` +
      `exists ${items.filter((i) => i.decision === 'exists').length} · waiting ${items.filter((i) => i.decision === 'waiting').length} · skipped ${items.filter((i) => i.decision === 'skipped').length}`);
    if (!apply) console.log(mode === 'pull' ? 'Dry run only. Add --apply to write.' : 'Dry run. To process chosen ones: npm run amazon:pull -- --ids <id,id> --apply');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
