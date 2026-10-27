/**
 * Channel names. Always use these: they are the channel folder names in S3
 * (po-intake/FY.../<month>/<channel>/, po-intake-not-po/<channel>/) and the names in channels.config.ts.
 * A new channel: add it here, then its entry in channels.config.ts.
 */
export const CHANNELS = {
  BIGBASKET: 'bigbasket',
  ZEPTO: 'zepto',
  FIRSTCRY: 'firstcry',
  BLINKIT: 'blinkit',
  RELIANCE: 'reliance',
  SCOOTSY: 'scootsy',
  PURPLLE: 'purplle',
  /** Amazon FBA inbound shipments, from SP-API (no email, no OCR; 2026-10-16). */
  AMAZON: 'amazon',
  /** Tata 1mg by email: a CSV per PO, read by our own sheet reader (no OCR; 2026-10-26). */
  TATA1MG: 'tata1mg',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Folder for non-PO mail whose sender matches no channel: po-intake-not-po/other/. */
export const OTHER_CHANNEL = 'other';

/**
 * Each channel's name in the OCR repo (ocr-service/dev/scripts/channels.json), passed to run_po.py.
 * Same as ours today; kept apart because it is the OCR team's naming (their PDF channel is "purple").
 */
export const OCR_CHANNELS: Record<ChannelName, string> = {
  [CHANNELS.BIGBASKET]: 'bigbasket',
  [CHANNELS.ZEPTO]: 'zepto',
  [CHANNELS.FIRSTCRY]: 'firstcry',
  [CHANNELS.BLINKIT]: 'blinkit',
  [CHANNELS.RELIANCE]: 'reliance',
  [CHANNELS.SCOOTSY]: 'scootsy',
  [CHANNELS.PURPLLE]: 'purplle',
  /** Not OCR'd: Amazon comes from its API. Kept so every channel has an entry. */
  [CHANNELS.AMAZON]: 'amazon',
  /** Not OCR'd: its CSV is read by our sheet reader (channels.config reader: 'sheet'). */
  [CHANNELS.TATA1MG]: 'tata1mg',
};
