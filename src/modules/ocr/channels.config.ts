/**
 * Channel configuration for extractPo().
 *
 * One entry per channel. To add a channel, add an entry here (and make sure its `ocrChannel`
 * exists in ocr-service/dev/scripts/channels.json with the same "expects").
 */
export interface ChannelConfig {
  /** Our channel name. */
  channel: string;
  /** Channel name passed to run_po.py (a key in ocr-service/dev/scripts/channels.json). */
  ocrChannel: string;
  /** Who sends this channel's POs: full addresses or "@domain". Matched against metadata.from. */
  senders: string[];
  /** Optional: the subject must also match (keeps out replies and other mail from the same sender). */
  subject?: RegExp;
  /**
   * The files the OCR needs; must match "expects" in channels.json:
   * pdf only -> { pdf }, sheet only -> { sheet }, pdf + sheet -> { pdf, sheet }.
   * Each pattern is tested against the attachment file names; the first match is used.
   */
  files: {
    pdf?: RegExp;
    sheet?: RegExp;
  };
  /**
   * For channels that send download links instead of attachments: the links in the email body
   * to download into the email folder before the files are picked. Each link is found by its
   * text; only `allowedHosts` may be fetched (including redirect targets).
   */
  links?: {
    items: { name: string; text: RegExp; required: boolean }[];
    allowedHosts: string[];
  };
}

export const channelConfigs: ChannelConfig[] = [
  {
    // PosFromEmail/BigBasket: Reply-To alerts@bigbasket.com,
    // subject "Big Basket <warehouse> PO Details: PO No IRA<digits> <vendor>", one .xlsx, no PDF.
    channel: 'bigbasket',
    ocrChannel: 'bigbasket',
    senders: ['alerts@bigbasket.com'],
    subject: /^Big Basket .+ PO Details: PO No [A-Z]{3}\d+/i,
    files: { sheet: /\.xlsx?$/i },
  },

  {
    // PosFromEmail/Zepto: Reply-To po_fulfilment@zeptonow.com, subject "Purchase Order for [<entity> and P<digits>]",
    // <PO>.csv (header + all lines) and <PO>.pdf (page 1 = PO, page 2 = terms) -> pdf + sheet pipeline.
    // Not in the OCR repo's channels.json yet, so run_po.py uses its defaults (no "expects" check).
    channel: 'zepto',
    ocrChannel: 'zepto',
    senders: ['po_fulfilment@zeptonow.com'],
    subject: /^Purchase Order for \[.+ and P\d+\]$/,
    files: { pdf: /\.pdf$/i, sheet: /\.csv$/i },
  },

  {
    // PosFromEmail/FirstCry: Reply-To noreply@firstcry.com, subject "<entity> PONO pin<9 digits><7 chars> for <stockist>".
    // No attachments: the body links "download PO PDF" / "download PO Excel" (expire after 20 days) lead to a JS
    // redirect to a 10-minute S3 URL. The Excel (.xls) holds the whole PO -> sheet pipeline. The PDF is kept for reference.
    channel: 'firstcry',
    ocrChannel: 'firstcry',
    senders: ['noreply@firstcry.com'],
    subject: /^.+? PONO pin\d{9}[a-z0-9]{7} for .+$/i,
    files: { sheet: /\.(xlsx?|csv)$/i },
    links: {
      items: [
        { name: 'PO Excel', text: /download PO Excel/i, required: true },
        { name: 'PO PDF', text: /download PO PDF/i, required: false },
      ],
      allowedHosts: ['in-procure-dwdoc.brainbees.com', 'ind-purchase.s3.ap-south-1.amazonaws.com'],
    },
  },

  // Template for the next channel (e.g. Blinkit, pdf + sheet):
  // {
  //   channel: 'blinkit',
  //   ocrChannel: 'blinkit',
  //   senders: ['purchaseorder@handsontrades.com'],
  //   subject: /^PO_.+ : \d{4}-\d{2}-\d{2}$/,
  //   files: { pdf: /\.pdf$/i, sheet: /\.xlsx$/i },
  // },
];
