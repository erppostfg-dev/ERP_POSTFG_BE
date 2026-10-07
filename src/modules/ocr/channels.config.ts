import { CHANNELS, ChannelName } from '../../constants/channels';

/**
 * Channel configuration for extractPo().
 *
 * One entry per channel. To add a channel, add an entry here (and make sure its `ocrChannel`
 * exists in ocr-service/dev/scripts/channels.json with the same "expects").
 */
export interface ChannelConfig {
  /** Our channel name (from constants/channels.ts); also the channel folder name in S3. */
  channel: ChannelName;
  /** Channel name passed to run_po.py (a key in ocr-service/dev/scripts/channels.json). */
  ocrChannel: string;
  /** Who sends this channel's POs: full addresses or "@domain". Matched against metadata.from. */
  senders: string[];
  /** Optional: the subject must also match (keeps out replies and other mail from the same sender). */
  subject?: RegExp;
  /** The PO number in the subject (group 1): the PO's S3 folder name. Without it the folder is <date>_<id>. */
  poNumber?: RegExp;
  /** Sender domains of this channel (people, notices): files non-PO mail under po-intake-not-po/<channel>/. */
  domains: string[];
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
    channel: CHANNELS.BIGBASKET,
    ocrChannel: 'bigbasket',
    senders: ['alerts@bigbasket.com'],
    subject: /^Big Basket .+ PO Details: PO No [A-Z]{3}\d+/i,
    poNumber: /PO No ([A-Z]{3}\d+)/,
    domains: ['bigbasket.com'],
    files: { sheet: /\.xlsx?$/i },
  },

  {
    // PosFromEmail/Zepto: Reply-To po_fulfilment@zeptonow.com, subject "Purchase Order for [<entity> and P<digits>]",
    // <PO>.csv (header + all lines) and <PO>.pdf (page 1 = PO, page 2 = terms) -> pdf + sheet pipeline.
    // Not in the OCR repo's channels.json yet, so run_po.py uses its defaults (no "expects" check).
    channel: CHANNELS.ZEPTO,
    ocrChannel: 'zepto',
    senders: ['po_fulfilment@zeptonow.com'],
    subject: /^Purchase Order for \[.+ and P\d+\]$/,
    poNumber: / and (P\d+)\]$/,
    domains: ['zeptonow.com'],
    files: { pdf: /\.pdf$/i, sheet: /\.csv$/i },
  },

  {
    // PosFromEmail/FirstCry: Reply-To noreply@firstcry.com, subject "<entity> PONO pin<9 digits><7 chars> for <stockist>".
    // No attachments: the body links "download PO PDF" / "download PO Excel" (expire after 20 days) lead to a JS
    // redirect to a 10-minute S3 URL. The Excel (.xls) holds the whole PO -> sheet pipeline. The PDF is kept for reference.
    channel: CHANNELS.FIRSTCRY,
    ocrChannel: 'firstcry',
    senders: ['noreply@firstcry.com'],
    subject: /^.+? PONO pin\d{9}[a-z0-9]{7} for .+$/i,
    poNumber: /PONO (pin\w+)/i,
    domains: ['firstcry.com', 'brainbees.com'],
    files: { sheet: /\.(xlsx?|csv)$/i },
    links: {
      items: [
        { name: 'PO Excel', text: /download PO Excel/i, required: true },
        { name: 'PO PDF', text: /download PO PDF/i, required: false },
      ],
      allowedHosts: ['in-procure-dwdoc.brainbees.com', 'ind-purchase.s3.ap-south-1.amazonaws.com'],
    },
  },

  {
    // PosFromEmail/Blinkit(blink): subject "PO_<Bill To>_<CITY>_<warehouse>_<our entity>-<PO number> : <YYYY-MM-DD>",
    // Bill To "BCPL - …" or "BLINK COMMERCE PRIVATE LIMITED - …" (same company). <PO>_<date>_<time>.xlsx (all lines
    // and totals) + the same name .pdf (header on page 1, totals block near the end) -> pdf + sheet pipeline.
    // The samples (2026-09-28) came from purchaseorder@handsontrades.com; live POs since 2026-10-01 come from
    // ordering@partnersbiz.com.
    channel: CHANNELS.BLINKIT,
    ocrChannel: 'blinkit',
    senders: ['ordering@partnersbiz.com', 'purchaseorder@handsontrades.com'],
    subject: /^PO_.+-\d{10,16} : \d{4}-\d{2}-\d{2}$/,
    poNumber: /-(\d{10,16}) : \d{4}-\d{2}-\d{2}$/,
    domains: ['partnersbiz.com', 'handsontrades.com', 'grofers.com', 'zomato.com', 'blinkit.com'],
    files: { pdf: /\.pdf$/i, sheet: /\.xlsx$/i },
  },

  {
    // PosFromEmail/Reliance: Reply-To noreply@ril.com, subject "PO. INTM: <10-digit PO> .PDF Reliance Retail Limited",
    // one PDF "PO. INTM_ <PO> .PDF Reliance Retail Limited.PDF" (page 1 = header, then lines up to "Grand Total of Qty",
    // last 10 pages = terms) -> pdf pipeline. Replies from Reliance staff (@ril.com, "Re: PO. INTM: …") don't match.
    // Not in the OCR repo's channels.json yet, so run_po.py uses its defaults (no "expects" check).
    channel: CHANNELS.RELIANCE,
    ocrChannel: 'reliance',
    senders: ['noreply@ril.com'],
    subject: /^PO\. INTM:\s*\d{10}\s*\.PDF Reliance Retail Limited$/i,
    poNumber: /INTM:\s*(\d{10})/,
    domains: ['ril.com', 'qwik.co.in'],
    files: { pdf: /\.pdf$/i },
  },

  {
    // PosFromEmail/Scootsy (Swiggy Instamart): Reply-To no-reply.procurement@scootsy.com,
    // subject "<facility>-<PO number>-<our entity>", e.g. "JAI IM1-JPAPO76710-PEP TECHNOLOGIES PRIVATE LIMITED".
    // <file id>_CREATE_OTB_PURCHASE_ORDER_<uuid>.xlsx holds the whole PO -> sheet pipeline; the .pdf is kept for reference.
    // The PO number is the one in the subject, not the file id.
    // The PO prefix can hold digits: CI3PO…, FC5PO…, JN2PO… (3 of 27 prefixes; 21 of 144 POs from 15 Sep to 6 Oct).
    // A "Re:" / "Fw:" / "Fwd:" subject is a reply, never a PO.
    channel: CHANNELS.SCOOTSY,
    ocrChannel: 'scootsy',
    senders: ['no-reply.procurement@scootsy.com'],
    subject: /^(?!\s*(re|fw|fwd)\s*:).+?-[A-Z0-9]{2,6}PO\d+-.+$/i,
    poNumber: /-([A-Z0-9]{2,6}PO\d+)-/,
    domains: ['scootsy.com', 'swiggy.in'],
    files: { sheet: /\.xlsx$/i },
  },

  {
    // PosFromEmail/Purple(PO not there in Email): From IT0002@purplle.com, subject "Purplle <our entity> Dt DD/MM/YY".
    // One email = a summary of ALL POs raised that day (no PO PDF). EXECL_ATTACHED.XLS is really tab-separated text
    // (one row per PO line, 14 columns, trailing NUL bytes) -> sheet pipeline, not the OCR repo's "purple" (pdf) entry.
    // The same sender also sends "Purplle OPN PO … Dt …" (a list of OPEN POs, same EXECL_ATTACHED.XLS), "Purplle GRN … Dt …"
    // and "Purplle RTV DN for RTV PO …": none of them is a new PO.
    channel: CHANNELS.PURPLLE,
    ocrChannel: 'purplle',
    senders: ['it0002@purplle.com'],
    subject: /^Purplle (?!OPN PO\b|GRN\b|RTV\b).+ Dt \d{2}\/\d{2}\/\d{2}$/i,
    // No PO number in the subject (one email = all POs of the day): the folder is <date>_<id>.
    domains: ['purplle.com'],
    files: { sheet: /\.(xlsx?|csv|tsv|txt)$/i },
  },
];
