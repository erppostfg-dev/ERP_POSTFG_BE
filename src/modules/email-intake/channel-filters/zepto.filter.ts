import { ChannelEmailFilter } from './channel-filter.types';

/*
 * Built from PosFromEmail/Zepto/Email-Format-1.txt and Email-Format-2.txt:
 *   from:        po_fulfilment via SupplyPo <supplyPO@mcaffeine.com>   (rewritten by the Google Group)
 *   reply-to:    po_fulfilment@zeptonow.com                             (the real sender)
 *   subject:     Purchase Order for [<our entity> and <PO number>]
 *   mailing list: supplyPO@mcaffeine.com
 *   attachments: <PO>.csv (required), <PO>.pdf
 */
const ZEPTO_SENDER = 'po_fulfilment@zeptonow.com';
const SUBJECT_RE = /^Purchase Order for \[(?<vendor>.+) and (?<poNumber>P\d+)\]$/;

export const zeptoFilter: ChannelEmailFilter = {
  channel: 'Zepto',

  // Gmail cannot search Reply-To, so the sender is checked in matchHeaders.
  gmailQuery: 'list:supplyPO@mcaffeine.com subject:"Purchase Order for" has:attachment',

  matchHeaders(headers) {
    const realSender = `${headers['reply-to'] ?? ''} ${headers['x-original-sender'] ?? ''}`.toLowerCase();
    if (!realSender.includes(ZEPTO_SENDER)) {
      return { matched: false, reason: `sender is not ${ZEPTO_SENDER}` };
    }

    const subject = (headers['subject'] ?? '').trim();
    const m = SUBJECT_RE.exec(subject);
    if (!m?.groups) {
      return { matched: false, reason: 'subject does not match "Purchase Order for [<entity> and P<digits>]"' };
    }

    return { matched: true, extracted: { vendor: m.groups.vendor, poNumber: m.groups.poNumber } };
  },

  attachments: {
    keep: /\.(csv|pdf)$/i,
    required: [/\.csv$/i],
  },
};
