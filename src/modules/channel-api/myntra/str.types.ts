import type { StrSummary } from './str.parse';

/** What a Myntra STR's channel_pull_items row keeps (data): its email, place in it, tries, the S3 folder once stored. */
export interface StrItemData {
  email: { folder: string; subject: string; receivedAt: string | null };
  order: number;
  group: string;
  priority: string;
  destination: string;
  runs: number;
  lastError: string | null;
  s3Folder?: string;
  summary?: StrSummary;
}
