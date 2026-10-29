import fs from 'fs/promises';
import path from 'path';
import { INTRANSIT_SOURCE, IntransitSource } from '../../constants';
import { validateInput } from './catalog';
import { writeWithMeta } from './input-store';
import { AmazonConfig, fetchAmazon } from './sources/amazon';
import { fetchFlipkart, FlipkartConfig } from './sources/flipkart';
import { Log } from './sources/http';
import { fetchMyntra, MyntraConfig } from './sources/myntra-partner-portal';
import { fetchUniware, UniwareConfig } from './sources/uniware';

/*
 * One connector fetch as the page runs it: the connector writes its files into the run's export folder, each file is
 * checked like an upload (validateInput), and the good ones become the inputs of the day fetched for
 * (inputs/daily/<date>/, with their meta; this is the Python's separate "Copy from api_exports" step, done at once).
 * A file that fails the check is left in the export folder and reported.
 */

export interface ConnectorConfig {
  amazon: AmazonConfig;
  flipkart: FlipkartConfig;
  myntra: MyntraConfig;
  uniware: UniwareConfig;
}

export interface ConnectorOptions {
  /** The day fetched for (YYYY-MM-DD, IST); data up to the end of that day. Default today. */
  date?: string;
  /** amazon / flipkart (Seller Hub) / myntra: 'soh' | 'grn'; uniware: 'b2b' | 'po' | 'inventory' (only these exports); empty = all. */
  only?: string | string[];
  /** Who asked (written into the files' meta). */
  by?: number | null;
  byName?: string | null;
  /** amazon: re-fetch every CLOSED shipment instead of reusing cached units. */
  refreshCache?: boolean;
}

export interface ConnectorDirs {
  /** Where the checked files go: the day's daily folder; null = nowhere (the server process stores them in Drive). */
  targetDir: string | null;
  /** A folder holding the day's Shipment_Status.csv (Amazon GRN reads it there). */
  mastersDir: string;
  /** This run's download folder. */
  exportDir: string;
  /** Kept between runs (Amazon's closed-shipment cache). */
  cacheDir: string;
}

export interface ConnectorResult {
  /** Files that passed the check and are now the day's inputs. */
  saved: string[];
  /** Files that failed the check: name -> problems (left in the export folder). */
  rejected: Record<string, string[]>;
}

/** The `only` option as a list (empty = everything). */
export const onlyList = (only: ConnectorOptions['only']): string[] => (Array.isArray(only) ? only : only ? [only] : []).filter(Boolean);

export const fetchSource = (source: IntransitSource, cfg: ConnectorConfig, dirs: ConnectorDirs, opts: ConnectorOptions, log: Log): Promise<string[]> => {
  const only = onlyList(opts.only);
  switch (source) {
    case INTRANSIT_SOURCE.AMAZON: {
      const one = only.length === 1 && (only[0] === 'soh' || only[0] === 'grn') ? only[0] : undefined;
      return fetchAmazon(cfg.amazon, { inputDir: dirs.mastersDir, outDir: dirs.exportDir, cacheDir: dirs.cacheDir }, log, {
        only: one,
        refreshCache: opts.refreshCache,
        asOf: opts.date,
      });
    }
    case INTRANSIT_SOURCE.UNIWARE:
      return fetchUniware(cfg.uniware, dirs.exportDir, log, only.length ? only : undefined, opts.date);
    case INTRANSIT_SOURCE.FLIPKART:
      return fetchFlipkart(cfg.flipkart, { outDir: dirs.exportDir, cacheDir: dirs.cacheDir }, log, only.length ? only : undefined);
    case INTRANSIT_SOURCE.MYNTRA:
      return fetchMyntra(cfg.myntra, { outDir: dirs.exportDir, cacheDir: dirs.cacheDir }, log, only.length ? only : undefined);
  }
};

/** Fetch, check, and store the good files as the day's inputs. */
export const runConnector = async (source: IntransitSource, cfg: ConnectorConfig, dirs: ConnectorDirs, opts: ConnectorOptions, log: Log): Promise<ConnectorResult> => {
  await fs.mkdir(dirs.exportDir, { recursive: true });
  const written = await fetchSource(source, cfg, dirs, opts, log);
  const result: ConnectorResult = { saved: [], rejected: {} };
  for (const name of written) {
    const from = path.join(dirs.exportDir, name);
    const raw = new Uint8Array(await fs.readFile(from));
    const problems = validateInput(name, raw);
    if (problems.length) {
      result.rejected[name] = problems;
      log(`  ${name} NOT used: ${problems.join('; ')}`);
      continue;
    }
    if (dirs.targetDir) {
      await writeWithMeta(path.join(dirs.targetDir, name), raw, { by: opts.by, byName: opts.byName, source });
      log(`  ${name} now used as the input of ${path.basename(dirs.targetDir)}`);
    } else log(`  ${name} passed the check`);
    result.saved.push(name);
  }
  return result;
};
