/*
 * Regression snapshot for D2C internal transfers (2026-11-03; plan section 3 "Regression check"): READ ONLY. Calls the
 * service functions behind the screens that must not change when transfers exist (not HTTP, so no login needed):
 *   - PO Overview: shipments + lines (every page, full access), filter options, live changes after a cursor
 *     (as GET /po-overview/changes answers: transfer changes dropped);
 *   - PO Review: the list of every upload status (every page);
 *   - PO Verify: the channel settings;
 *   - Manual Upload: the channel list.
 * Writes one JSON file per section + manifest.json (sha256 per section and overall) into --out. Run it before and
 * after creating test transfers and compare the manifests: every hash must be the same. Pass the baseline's cursor
 * (manifest.changesAfter) as --after to the second run so both read the same log window.
 *
 *   npx ts-node --transpile-only src/scripts/d2c-regression-snapshot.ts --out <dir> [--after <shipment_logs id>]
 */
import 'reflect-metadata';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { COLUMN_ACCESS, PO_REVIEW_LIST, PO_TEAM_ORDER, PoTeam, UPLOAD_STATUS, UploadStatus } from '../constants';
import { uploadChannels } from '../modules/manual-upload/manual-upload.service';
import { PoOverviewAccess } from '../modules/po-overview/po-overview.access';
import { changesSince, lastLogId } from '../modules/po-overview/po-overview.live';
import { PoOverviewFilters } from '../modules/po-overview/po-overview.queries';
import { getFilterOptions, listLines, listShipments } from '../modules/po-overview/po-overview.service';
import { listPoReview } from '../modules/po-review/po-review.service';
import { listChannelSettings } from '../modules/po-verify/po-verify.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg('out');
const PAGE_SIZE = 500;
const MAX_PAGES = 200;
/** How far back the live-changes window starts when no --after is given. */
const CHANGES_WINDOW = 500;

/** JSON with object keys sorted, so the same data always hashes the same. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : x, 2);

const fullAccess: PoOverviewAccess = {
  team: null,
  groups: Object.fromEntries(PO_TEAM_ORDER.map((t) => [t, COLUMN_ACCESS.EDIT])) as Record<PoTeam, typeof COLUMN_ACCESS.EDIT>,
  facilityScoped: false,
  facilityIds: [],
  facilityCodes: [],
};
const noFilters: PoOverviewFilters = {
  brand: [], channel: [], facility: [], location: [], statusPlanning: [], statusWarehouse: [], statusLogistics: [], statusFinal: [], transporter: [], notAssigned: [],
};

/** Every page of a paged list. */
const allPages = async <T>(fetch: (page: number) => Promise<{ items: T[]; total: number }>): Promise<{ total: number; items: T[] }> => {
  const items: T[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(page);
    total = r.total;
    items.push(...r.items);
    if (items.length >= r.total || !r.items.length) break;
  }
  return { total, items };
};

const main = async (): Promise<void> => {
  if (!OUT) throw new Error('usage: d2c-regression-snapshot --out <dir> [--after <shipment_logs id>]');
  await AppDataSource.initialize(); // guarded: only the allowed databases
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const latest = await lastLogId();
    const after = arg('after') !== undefined ? Number(arg('after')) : Math.max(0, latest - CHANGES_WINDOW);
    const sections: Record<string, unknown> = {};

    sections['po-overview-shipments'] = await allPages((page) => listShipments(noFilters, { page, pageSize: PAGE_SIZE }, fullAccess));
    sections['po-overview-lines'] = await allPages((page) => listLines(noFilters, { page, pageSize: PAGE_SIZE }, fullAccess));
    sections['po-overview-filter-options'] = await getFilterOptions();
    // as GET /po-overview/changes answers: transfer changes dropped, no flag
    sections['po-overview-changes'] = (await changesSince(after)).filter((c) => !c.isTransfer).map(({ isTransfer: _t, ...c }) => c);
    for (const status of Object.values(UPLOAD_STATUS) as UploadStatus[]) {
      sections[`po-review-${status}`] = await allPages((page) => listPoReview({ status, page, pageSize: PO_REVIEW_LIST.MAX_PAGE_SIZE }));
    }
    sections['po-verify-settings'] = await listChannelSettings();
    sections['manual-upload-channels'] = await uploadChannels();

    const hashes: Record<string, string> = {};
    for (const [name, data] of Object.entries(sections)) {
      const text = stable(data);
      fs.writeFileSync(path.join(OUT, `${name}.json`), `${text}\n`);
      hashes[name] = createHash('sha256').update(text).digest('hex');
    }
    const overall = createHash('sha256').update(Object.entries(hashes).map(([k, h]) => `${k}:${h}`).join('\n')).digest('hex');
    const manifest = { at: new Date().toISOString(), database: AppDataSource.options.database, changesAfter: after, latestLogId: latest, overall, sections: hashes };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [k, h] of Object.entries(hashes)) console.log(`${h.slice(0, 16)}  ${k}`);
    console.log(`overall ${overall}\nwritten to ${OUT} (changes after log id ${after}; pass --after ${after} to the next run)`);
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
