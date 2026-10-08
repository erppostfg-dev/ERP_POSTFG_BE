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
};
