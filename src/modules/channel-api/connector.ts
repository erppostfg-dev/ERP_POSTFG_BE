import { ChannelName, SourceSystem } from '../../constants';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { ChannelMasterData } from '../po-validation/master-data';

/*
 * The contract every channel API connector fulfils (2026-10-16, user: "extensible: Flipkart and others later").
 * A connector only knows its channel's API: what changed, the full data of one PO, and how it reads as our
 * processed.json. Everything else (check point, retries, S3, po_uploads, validation, review, sale order, CSV) is shared
 * (runner.ts, ingest.service.ts, the PO chain). A new channel = a new folder with one ChannelConnector + its entry in
 * registry.ts.
 */

/** One PO as the channel's change list reports it (enough to decide whether to fetch it). */
export interface ExternalRef {
  /** The channel's id (Amazon: FBA15...); unique per source system. */
  externalId: string;
  /** The channel's status now (Amazon: WORKING, READY_TO_SHIP ...). */
  status: string;
  /** Short text for the reports (Amazon: shipment name + FC). */
  label: string;
  /** The list entry as it came. */
  raw: unknown;
}

/** One PO with everything needed to build processed.json. */
export interface ExternalPo extends ExternalRef {
  /** Our PO number (Amazon: the FBA id). */
  poNumber: string;
  /** When the channel created it (ISO); the S3 month folder and the PO date. */
  createdAt: string;
  /** Saved as api-raw.json, exactly as received. */
  rawFull: unknown;
}

export interface ChannelConnector {
  key: SourceSystem;
  channel: ChannelName;
  label: string;
  /** Minutes between polls: the connector's env value, else CHANNEL_API.DEFAULT_POLL_MINUTES. */
  pollMinutes(): number;
  /** Keys present (a connector without keys is skipped, with a log line). */
  configured(): boolean;
  /** POs changed in [since, until), any status. */
  listChanged(since: Date, until: Date): Promise<ExternalRef[]>;
  /** The same for given ids (retries, and the pull command's --ids). */
  listByIds(ids: string[]): Promise<ExternalRef[]>;
  /** Full data of one PO (its lines). */
  fetch(ref: ExternalRef): Promise<ExternalPo>;
  /** Our common-format PO; prices / MRP may come from our master (the channel may send none). */
  toProcessed(po: ExternalPo, master: ChannelMasterData | null): ProcessedPo;
  /** From this status on the PO becomes a PO + sale order. */
  isReady(status: string): boolean;
  /** Never becomes a PO (cancelled, closed ...). */
  isSkipped(status: string): boolean;
}
