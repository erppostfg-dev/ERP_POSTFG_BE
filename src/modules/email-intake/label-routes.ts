/**
 * Gmail label -> API endpoint.
 *
 * Gmail filters in the intake mailbox put a label on emails. Every email that gets a listed label
 * is pulled, with all its attachments, and sent to that label's endpoint. The label is the filter:
 * nothing is skipped. Add a row per label; the Gmail watch covers every label listed here.
 */
export interface LabelRoute {
  /** Gmail label name, exactly as shown in Gmail (case-insensitive). */
  label: string;
  /** Endpoint path (joined to INTAKE_BASE_URL) or a full URL. */
  endpoint: string;
}

export const labelRoutes: LabelRoute[] = [{ label: 'Po-Intake', endpoint: '/po-intake/email' }];
