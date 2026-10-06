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
