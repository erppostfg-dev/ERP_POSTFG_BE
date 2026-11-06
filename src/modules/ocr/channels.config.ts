import { CHANNELS, ChannelName, OCR_CHANNELS } from '../../constants/channels';

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
  /**
   * 'sheet' = NO OCR (2026-10-26): the channel's CSV already holds the whole PO, so our own sheet reader
   * (ocr/sheet-reader.ts) reads EVERY attachment matching `files.sheet` into the raw JSON, and the chain goes on as
   * after an OCR run. A new CSV channel then only needs this entry + its handler's column mapping.
   */
  reader?: 'sheet';
  /**
   * Files of `files` that the channel usually sends but the PO does not need (2026-10-26): kept and shown when there,
   * never required (email rule, reading, Manual Upload). Tata 1mg: the PDF (all the data is in its CSV).
   */
  optional?: ('pdf' | 'sheet')[];
  /** One file holds many POs (Nykaa's export, 2026-10-27): told on the Manual Upload screen. */
  manyPosPerFile?: boolean;
  /**
   * reader 'sheet' (2026-11-05): the row that holds the column names, when it is not the first one (Noble Chemist's
   * form: 5 title rows first). Rows above it go to the raw header as "Line 1", "Line 2" ... (their text joined).
   */
  sheetHeader?: RegExp;
}

export const channelConfigs: ChannelConfig[] = [
  {
    // PosFromEmail/BigBasket: Reply-To alerts@bigbasket.com,
    // subject "Big Basket <warehouse> PO Details: PO No IRA<digits> <vendor>", one .xlsx, no PDF.
    channel: CHANNELS.BIGBASKET,
    ocrChannel: OCR_CHANNELS[CHANNELS.BIGBASKET],
    senders: ['alerts@bigbasket.com'],
    subject: /^Big Basket .+ PO Details: PO No [A-Z]{3}\d+/i,
    poNumber: /PO No ([A-Z]{3}\d+)/,
    domains: ['bigbasket.com'],
    files: { sheet: /\.xlsx?$/i },
  },

  {
    // PosFromEmail/Zepto: Reply-To po_fulfilment@zeptonow.com, subject "Purchase Order for [<entity> and P<digits>]",
    // <PO>.csv (header + all lines) and <PO>.pdf (page 1 = PO, page 2 = terms) -> pdf + sheet pipeline.
    // channels.json "zepto" expects pdf+sheet (2026-11-02: it said sheet + flat_csv, which refused every Zepto PO).
    channel: CHANNELS.ZEPTO,
    ocrChannel: OCR_CHANNELS[CHANNELS.ZEPTO],
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
    ocrChannel: OCR_CHANNELS[CHANNELS.FIRSTCRY],
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
    ocrChannel: OCR_CHANNELS[CHANNELS.BLINKIT],
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
    ocrChannel: OCR_CHANNELS[CHANNELS.RELIANCE],
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
    ocrChannel: OCR_CHANNELS[CHANNELS.SCOOTSY],
    senders: ['no-reply.procurement@scootsy.com'],
    subject: /^(?!\s*(re|fw|fwd)\s*:).+?-[A-Z0-9]{2,6}PO\d+-.+$/i,
    poNumber: /-([A-Z0-9]{2,6}PO\d+)-/,
    domains: ['scootsy.com', 'swiggy.in'],
    files: { sheet: /\.xlsx$/i },
  },

  {
    // PosFromEmail/Purple(PO not there in Email): From IT0002@purplle.com, subject "Purplle <our entity> Dt DD/MM/YY".
    // One email = a summary of ALL POs raised that day (no PO PDF). EXECL_ATTACHED.XLS is really tab-separated text
    // (one row per PO line, 14 columns, trailing NUL bytes) -> sheet pipeline (the OCR's "purplle" entry takes a sheet or a PDF).
    // The same sender also sends "Purplle OPN PO … Dt …" (a list of OPEN POs, same EXECL_ATTACHED.XLS), "Purplle GRN … Dt …"
    // and "Purplle RTV DN for RTV PO …": none of them is a new PO.
    channel: CHANNELS.PURPLLE,
    ocrChannel: OCR_CHANNELS[CHANNELS.PURPLLE],
    senders: ['it0002@purplle.com'],
    subject: /^Purplle (?!OPN PO\b|GRN\b|RTV\b).+ Dt \d{2}\/\d{2}\/\d{2}$/i,
    // No PO number in the subject (one email = all POs of the day): the folder is <date>_<id>.
    domains: ['purplle.com'],
    files: { sheet: /\.(xlsx?|csv|tsv|txt)$/i },
  },

  {
    // Tata 1mg (2026-10-26): via the SupplyPo group (From supplyPO@, X-Original-Sender / Reply-To cpd.otc@1mg.com),
    // subject "Purchase Order -|| <PO> / <PO> || ( dd/mm/yyyy ) || Pep Technologies Pvt. Ltd / Kreative Beauty Pvt Ltd
    // || ... || TATA 1MG_<city>". One email = one PO per company (mCaffeine / Hyphen), each a CSV + a PDF; the CSVs
    // hold the whole PO -> no OCR (reader 'sheet'). Replies, "Pullout dispatch" and "Inventory Pullout Return" mails
    // from the same people don't match the subject. Several POs: no poNumber, the folder is <date>_<id>.
    channel: CHANNELS.TATA1MG,
    ocrChannel: OCR_CHANNELS[CHANNELS.TATA1MG],
    senders: ['cpd.otc@1mg.com'],
    subject: /^Purchase Order -\|\|/i,
    domains: ['1mg.com'],
    files: { pdf: /\.pdf$/i, sheet: /\.csv$/i },
    reader: 'sheet',
    // Every value we use is in the CSV; the PDF is only kept to look at.
    optional: ['pdf'],
  },

  {
    // Nykaa (2026-10-27): Manual Upload only. Someone downloads the vendor portal's "Purchase Orders" CSV
    // (Purchase Orders_allPo_<date>.csv: many POs, one row per line) and uploads it; no email, no OCR (reader 'sheet').
    // No senders / domains, so no email ever matches this channel.
    channel: CHANNELS.NYKAA,
    ocrChannel: OCR_CHANNELS[CHANNELS.NYKAA],
    senders: [],
    domains: [],
    files: { sheet: /\.csv$/i },
    reader: 'sheet',
    manyPosPerFile: true,
  },

  {
    // Avenue E-Commerce (DMart, 2026-10-30): the PO PDF ("Purchase Order 4502349805", lines printed on two rows) by
    // Manual Upload only; read by the OCR (channels.json "avenue", expects pdf). No senders / domains: no email matches.
    channel: CHANNELS.AVENUE,
    ocrChannel: OCR_CHANNELS[CHANNELS.AVENUE],
    senders: [],
    domains: [],
    files: { pdf: /\.pdf$/i },
  },

  {
    // Flipkart Quick Commerce (2026-10-30): purchase_order_<PO>.xls (header block, line table, totals in one sheet) by
    // Manual Upload only; read by the OCR sheet pipeline (channels.json "flipkart_quickcomm": lines and totals by Python,
    // only the header block goes to its model). No senders / domains: no email matches.
    channel: CHANNELS.FLIPKART_QCOM,
    ocrChannel: OCR_CHANNELS[CHANNELS.FLIPKART_QCOM],
    senders: [],
    domains: [],
    files: { sheet: /\.xlsx?$/i },
  },

  {
    // Gluzo (2026-11-02): <PO>_244809_<timestamp>.pdf made by EasyEcom (header, every line, totals on the last page) by
    // Manual Upload only; read by the OCR PDF pipeline (channels.json "gluzo", expects pdf). Option B (user): the PDF alone;
    // Gluzo's xlsx ("Purchase Order No-<PO>.xlsx") holds the same lines without the header, so it is not taken.
    channel: CHANNELS.GLUZO,
    ocrChannel: OCR_CHANNELS[CHANNELS.GLUZO],
    senders: [],
    domains: [],
    files: { pdf: /\.pdf$/i },
  },

  {
    // Slikk (2026-11-02): the PO PDF (random name, e.g. 0732ef90....pdf; header + printed totals) with its line sheet
    // (orderItems ....csv or Pep SLIKPO#<n>.xlsx: every row carries the PO number in "Order"), always together (user: the
    // PDF alone is not taken). Manual Upload only, one PO per upload (the names never match). OCR "slikk": header from the
    // PDF, lines from the sheet.
    channel: CHANNELS.SLIKK,
    ocrChannel: OCR_CHANNELS[CHANNELS.SLIKK],
    senders: [],
    domains: [],
    files: { pdf: /\.pdf$/i, sheet: /\.(csv|xlsx?)$/i },
  },

  {
    // Pop Tech (Curioso Fashions, 2026-11-02): the Unicommerce PO PDF (DL_MCFN004.pdf, "UC_Invoice Copy_BLR_MCFN002.pdf";
    // header, every line and the unlabeled totals row; one PO per PDF). Manual Upload only for now (emails later, user).
    // OCR "pop_tech": PDF pipeline with split_value_rate_cells + unlabeled_total_row + header_notes.
    channel: CHANNELS.POP_TECH,
    ocrChannel: OCR_CHANNELS[CHANNELS.POP_TECH],
    senders: [],
    domains: [],
    files: { pdf: /\.pdf$/i },
  },
  {
    // First Club (Firstclub Technology, 2026-11-05): one PO PDF per PO ("PO-199751.pdf"; header, every line and the totals;
    // PO No. "PO-199751-FRHHYDMDL01" = number + First Club's warehouse code). Manual Upload only (user: no other source).
    // OCR "first_club": PDF pipeline with header_notes + line_notes (fixed names) + split_value_rate_cells.
    channel: CHANNELS.FIRST_CLUB,
    ocrChannel: OCR_CHANNELS[CHANNELS.FIRST_CLUB],
    senders: [],
    domains: [],
    files: { pdf: /\.pdf$/i },
  },
  {
    // Octavos (Octavos Enterprise Solutions = Smytten, 2026-11-05): one PO PDF per PO ("OG-00381-2026-27.pdf", PO No.
    // "OG/00381/2026-27"; OESPL / OG / OK / RET = Octavos' warehouses, RET are normal POs, user). Manual Upload only.
    // OCR "octavos": PDF pipeline with header_notes + line_notes (fixed names) + header_pages (page 1 + Grand Total page).
    channel: CHANNELS.OCTAVOS,
    ocrChannel: OCR_CHANNELS[CHANNELS.OCTAVOS],
    senders: [],
    domains: [],
    files: { pdf: /\.pdf$/i },
  },
  {
    // Noble Chemist (New Welcome Agencies Pvt Ltd, Goregaon West, 2026-11-05): its order form "Order No 88699.xls"
    // (old-style .xls: 5 title rows with DATE / Order No, then COMPANY | COMP UPC | ITEM NAME | PACK | QTY. | FREE | MRP |
    // REMARKS; no price). Manual Upload only. No OCR: our sheet reader (Excel through ocr-service sheet_rows.py).
    channel: CHANNELS.NOBLE_CHEMIST,
    ocrChannel: OCR_CHANNELS[CHANNELS.NOBLE_CHEMIST],
    senders: [],
    domains: [],
    files: { sheet: /\.(xls|xlsx|csv)$/i },
    reader: 'sheet',
    sheetHeader: /\bCOMP\s*UPC\b/i,
  },
  {
    // Amazon RK World (Amazon Vendor Central, 2026-11-06): the "PO Item Export" (POItemExport_<date>.xls, old-style .xls;
    // first sheet "Line Items": one row per PO line, several POs per file). Manual Upload only. No OCR: our sheet reader
    // (Excel through ocr-service sheet_rows.py); the handler splits the rows by PO (as Nykaa).
    channel: CHANNELS.AMAZON_RK_WORLD,
    ocrChannel: OCR_CHANNELS[CHANNELS.AMAZON_RK_WORLD],
    senders: [],
    domains: [],
    files: { sheet: /\.(xls|xlsx|csv)$/i },
    reader: 'sheet',
    // the column names (also refuses another export or sheet, with why)
    sheetHeader: /\bASIN\b.*\bRequested quantity\b/i,
    manyPosPerFile: true,
  },
];
