import { EventEmitter } from 'events';
import { AppDataSource } from '../../config/data-source';
import { LIVE, SHIPMENT_LOG_ACTION, TABLES } from '../../constants';

/*
 * Live updates of the PO Overview (2026-10-14, self-healing design):
 *   - every change to a shipment writes shipment_logs rows; their id is the message id (a cursor);
 *   - flushChanges() sends every log row after the last one sent, grouped per shipment, to the connected screens
 *     (SSE). It runs right after a save / a new PO (instant) and every LIVE.WATCH_MS (catches rows written by another
 *     process: a script, a second server), so nothing depends on one code path remembering to announce;
 *   - a screen that reconnects, or that polls /changes while its SSE is down, asks changesSince(its last id), so a
 *     missed message is never lost and a repeated one is harmless (the screen just re-reads that row).
 * Messages carry the shipment number, the action, the changed field names and who did it: never values (each screen
 * re-reads the row with its own access).
 */

export interface ShipmentChange {
  uid: string;
  /** The highest shipment_logs id of this change: the screen's new cursor. */
  logId: string;
  /** created (a new PO: lists reload) or field_changed / ... (the row is re-read). */
  action: string;
  fields: string[];
  /** Name of who did it; null = the pipeline. */
  by: string | null;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);
let lastSent = 0;
let started = false;
let flushing: Promise<void> | null = null;

/** The newest shipment_logs id (0 when empty). */
export const lastLogId = async (): Promise<number> => {
  const [row] = (await AppDataSource.query(`SELECT COALESCE(MAX(id), 0) id FROM ${TABLES.SHIPMENT_LOGS}`)) as { id: string | number }[];
  return Number(row?.id ?? 0);
};

/** Log rows after `after`, grouped per shipment (oldest first), at most LIVE.BATCH_MAX rows read. */
export const changesSince = async (after: number): Promise<ShipmentChange[]> => {
  const rows = (await AppDataSource.query(
    `SELECT l.id, l.shipment_uid uid, l.action, l.field_name field, u.name
       FROM ${TABLES.SHIPMENT_LOGS} l LEFT JOIN ${TABLES.USERS} u ON u.id = l.user_id
      WHERE l.id > ? ORDER BY l.id LIMIT ?`,
    [after, LIVE.BATCH_MAX],
  )) as { id: string | number; uid: string | number; action: string; field: string | null; name: string | null }[];
  const byUid = new Map<string, ShipmentChange>();
  for (const r of rows) {
    const uid = String(r.uid);
    const c = byUid.get(uid) ?? { uid, logId: '0', action: r.action, fields: [], by: null };
    c.logId = String(r.id);
    // A new PO stays "created" (lists reload); otherwise the latest action counts.
    if (c.action !== SHIPMENT_LOG_ACTION.CREATED) c.action = r.action;
    if (r.field && !c.fields.includes(r.field)) c.fields.push(r.field);
    c.by = r.name;
    byUid.delete(uid);
    byUid.set(uid, c);
  }
  return [...byUid.values()];
};

/** Sends every log row after the last one sent. Safe to call any time, from anywhere (calls are serialised). */
export const flushChanges = (): Promise<void> => {
  flushing = (flushing ?? Promise.resolve()).then(async () => {
    try {
      // No live screen in this process yet (or a command-line script): nothing to tell. The server's watcher sends
      // rows written by scripts within LIVE.WATCH_MS once a screen is connected.
      if (!started) return;
      for (let more = true; more; ) {
        const changes = await changesSince(lastSent);
        more = changes.length > 0;
        for (const c of changes) {
          if (Number(c.logId) > lastSent) lastSent = Number(c.logId);
          bus.emit('change', c);
        }
        if (changes.length && changes.length < LIVE.BATCH_MAX) more = false;
      }
    } catch (err) {
      // Self-healing: a failed check is retried by the next watcher tick; screens fall back to polling meanwhile.
      console.error('[live] flush failed:', err instanceof Error ? err.message : err);
    }
  });
  return flushing;
};

/** Starts the watcher once (first live screen); the cursor starts at the newest row, older ones are history. */
export const startLive = async (): Promise<void> => {
  if (started) return;
  started = true;
  try {
    lastSent = await lastLogId();
  } catch {
    lastSent = 0;
  }
  setInterval(() => void flushChanges(), LIVE.WATCH_MS).unref();
};

/** Subscribe to changes; returns the unsubscribe. */
export const onShipmentChange = (fn: (c: ShipmentChange) => void): (() => void) => {
  bus.on('change', fn);
  return () => bus.off('change', fn);
};
