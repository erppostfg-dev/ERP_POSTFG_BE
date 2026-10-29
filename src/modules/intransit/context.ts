import path from 'path';
import { Frame } from './frame';
import { readCsv } from './io';

/*
 * The run context passed through every stage (intransit-service/intransit/context.py). Stages talk to each other
 * only through named frames held here; which stage writes which frame is listed in pipeline.ts (FRAMES).
 */

export interface IntransitSettings {
  /** Folder with the 19 input CSVs. */
  inputDir: string;
  /** The template workbook (Intransit_Stock_Report.xlsx). */
  templateXlsx: string;
  /** Where the report is written. */
  outputDir: string;
  /** Reference date (YYYY-MM-DD) for the age-based rules, so a rerun gives the same report. */
  asOf: string;
  /**
   * Start date (YYYY-MM-DD): Shipment_Status rows and PO_Format lines with an earlier Entry Date are dropped before
   * the stages run (user's fix plan W1, 2026-10-19: the reference report starts at 1 Aug). Null/absent = keep all.
   */
  fromDate?: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The start date from a setting: "YYYY-MM-DD" (fixed), a number of days before asOf ("80" = rolling), or blank (none).
 * Throws on anything else, so a typo in .env or the request is not silently ignored.
 */
export const resolveFromDate = (spec: string | null | undefined, asOf: string): string | null => {
  const s = (spec ?? '').trim();
  if (s === '') return null;
  if (DAY_RE.test(s) && !Number.isNaN(Date.parse(s))) return s;
  if (/^\d+$/.test(s)) return new Date(Date.parse(asOf) - Number(s) * 86400000).toISOString().slice(0, 10);
  throw new Error(`start date must be YYYY-MM-DD or a number of days, got "${s}"`);
};

/** Export-B2B quantity lookups (stage lookups), used by quantities and b2b_orders. */
export interface Lookups {
  /** One row per PO: PO Number + QTY_COLS. */
  po: Frame;
  /** One row per (PO, Channel SKU Code). */
  channel: Frame;
  /** One row per (PO, SKU Code). */
  sku: Frame;
  /** The PO keys present in Export-B2B. */
  poKeys: Set<string>;
  /** PO key -> its distinct Sale Order Status values, comma-joined. */
  status: Map<string, string>;
  qtyCols: readonly string[];
}

export class Context {
  readonly frames = new Map<string, Frame>();
  readonly timings: Record<string, number> = {};
  lookups?: Lookups;
  private readonly inputs = new Map<string, Promise<Frame>>();
  private readonly t0 = Date.now();

  constructor(
    readonly settings: IntransitSettings,
    private readonly onLog?: (line: string) => void,
  ) {}

  log(msg: string): void {
    const line = `[${((Date.now() - this.t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`;
    if (this.onLog) this.onLog(line);
    else console.log(line);
  }

  inputPath(name: string): string {
    return path.join(this.settings.inputDir, name);
  }

  /** All-text read of an input CSV, cached for the run (frames are never changed in place, so sharing is safe). */
  readInput(name: string): Promise<Frame> {
    let f = this.inputs.get(name);
    if (!f) this.inputs.set(name, (f = readCsv(this.inputPath(name))));
    return f;
  }

  get(name: string): Frame {
    const f = this.frames.get(name);
    if (!f) throw new Error(`frame not built yet: ${name}`);
    return f;
  }

  set(name: string, frame: Frame): void {
    this.frames.set(name, frame);
  }

  getLookups(): Lookups {
    if (!this.lookups) throw new Error('lookups not built yet');
    return this.lookups;
  }
}

/** "1234567" -> "1,234,567" (Python's f"{n:,}"). */
export const fmtInt = (n: number): string => Math.trunc(n).toLocaleString('en-US');
