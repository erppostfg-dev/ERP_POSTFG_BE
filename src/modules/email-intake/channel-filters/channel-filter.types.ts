/** Email headers the filters look at (lower-case keys). */
export type EmailHeaders = Record<string, string>;

export interface FilterResult {
  matched: boolean;
  /** Why the email did not match (for logs). */
  reason?: string;
  /** Values taken from the subject, e.g. { poNumber, vendor }. */
  extracted?: Record<string, string>;
}

export interface ChannelEmailFilter {
  channel: string;
  /** Gmail search query: a rough first cut done by Gmail. */
  gmailQuery: string;
  /** Strict check on the headers, done by us before anything is downloaded. */
  matchHeaders(headers: EmailHeaders): FilterResult;
  /** Which attachments to keep, and which are required. */
  attachments: {
    keep: RegExp;
    required: RegExp[];
  };
}
