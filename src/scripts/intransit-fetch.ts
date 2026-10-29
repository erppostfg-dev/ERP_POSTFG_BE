/*
 * Run an in-transit connector by hand (the page's "Fetch from APIs" without the server).
 *
 *   npm run intransit:fetch -- --source amazon|uniware|flipkart|myntra [--date YYYY-MM-DD] [--only soh|grn|b2b|po|inventory] [--refresh-cache]
 *   npm run intransit:fetch -- --source myntra [--only soh|grn] [--headed]     (Partner Portal robot; --headed shows its browser)
 *   npm run intransit:fetch -- --source amazon --check          (login + API permissions only)
 *   npm run intransit:fetch -- --source flipkart --probe        (save Flipkart's raw reports and show their columns)
 *   npm run intransit:fetch -- --source flipkart [--only soh|grn] [--headed]   (Seller Hub robot when FLIPKART_SELLER_USER
 *                                                                is set; --headed shows its browser)
 *   npm run intransit:fetch -- --source uniware --out-dir x     (only download into x; the inputs are not touched)
 *
 * Without --out-dir the files are checked and, when they pass, become the inputs of the day (default today) in
 * INTRANSIT_DIR/inputs/daily/<day>/. Amazon_GRN reads Shipment_Status.csv from inputs/masters/.
 * Credentials come from .env (SPAPI_*, FLIPKART_*, MYNTRA_PARTNER_*, UNIWARE_*); Uniware's facilities from master_facilities.uniware_export
 * (the database is connected for that; without one, the old .env UNIWARE_FACILITY list).
 */
import 'reflect-metadata';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { INTRANSIT_FOLDERS, INTRANSIT_SOURCE, IntransitSource } from '../constants';
import { ConnectorConfig, fetchSource, runConnector } from '../modules/intransit/connectors';
import { checkDate, dailyDir, mastersDir } from '../modules/intransit/input-store';
import { checkAmazon } from '../modules/intransit/sources/amazon';
import { checkFlipkart, probeFlipkart } from '../modules/intransit/sources/flipkart';
import { checkMyntra } from '../modules/intransit/sources/myntra-partner-portal';
import { checkUniware } from '../modules/intransit/sources/uniware';
import { uniwareFacilities } from '../modules/intransit/uniware-facilities';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const main = async (): Promise<void> => {
  const source = arg('source') as IntransitSource | undefined;
  const sources = Object.values(INTRANSIT_SOURCE) as string[];
  if (!source || !sources.includes(source)) throw new Error(`Give --source ${sources.join('|')}`);
  const log = (msg: string): void => console.log(msg);
  let facilities = env.intransit.uniware.facilities;
  if (source === 'uniware' && env.db.enabled) {
    await AppDataSource.initialize();
    const f = await uniwareFacilities().finally(() => AppDataSource.destroy());
    facilities = f.codes;
    log(`Uniware facilities: ${f.codes.length} from ${f.from === 'database' ? 'master_facilities.uniware_export' : '.env UNIWARE_FACILITY'}`);
  }
  // --headed: show the Seller Hub / Partner Portal robot's browser (debugging)
  const flipkart = { ...env.intransit.flipkart, sellerHub: { ...env.intransit.flipkart.sellerHub, headless: flag('headed') ? false : env.intransit.flipkart.sellerHub.headless } };
  const myntra = { ...env.intransit.myntra, headless: flag('headed') ? false : env.intransit.myntra.headless };
  const cfg: ConnectorConfig = { amazon: env.intransit.amazon, flipkart, myntra, uniware: { ...env.intransit.uniware, facilities } };
  const dir = path.resolve(env.intransit.dir);
  const date = checkDate(arg('date'));
  const dirs = { targetDir: dailyDir(date), mastersDir: mastersDir() };
  const cacheDir = path.join(dir, INTRANSIT_FOLDERS.CACHE);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (flag('check')) {
    if (source === 'amazon') await checkAmazon(cfg.amazon, log);
    else if (source === 'flipkart') await checkFlipkart(cfg.flipkart, log, cacheDir);
    else if (source === 'myntra') await checkMyntra(cfg.myntra, cacheDir, log);
    else await checkUniware(cfg.uniware, log);
    return;
  }
  if (flag('probe')) {
    if (source !== 'flipkart') throw new Error('--probe is for --source flipkart');
    await probeFlipkart(cfg.flipkart, path.join(dir, INTRANSIT_FOLDERS.EXPORTS, 'flipkart_probe'), log, arg('warehouse'), Number(arg('days') ?? 7));
    return;
  }
  const options = { date, only: arg('only'), refreshCache: flag('refresh-cache') };
  const outDir = arg('out-dir');
  if (outDir) {
    const written = await fetchSource(source, cfg, { ...dirs, exportDir: path.resolve(outDir), cacheDir }, options, log);
    console.log(`Written to ${path.resolve(outDir)}: ${written.join(', ')}`);
    return;
  }
  const result = await runConnector(source, cfg, { ...dirs, exportDir: path.join(dir, INTRANSIT_FOLDERS.EXPORTS, source, `cli-${stamp}`), cacheDir }, options, log);
  console.log(`Now used as the inputs of ${date}: ${result.saved.join(', ') || 'none'}`);
  if (Object.keys(result.rejected).length) {
    console.log('Not used:', result.rejected);
    process.exit(1);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
