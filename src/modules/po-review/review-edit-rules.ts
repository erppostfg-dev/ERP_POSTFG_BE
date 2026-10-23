import { ISSUE_TYPE } from '../../constants';

/*
 * What a reviewer may change on a PO in review (user, 2026-10-22): by default only the values that show an error;
 * a role with the "PO Review: edit all fields" permission (CAPABILITY.PO_REVIEW_EDIT_ALL, Roles tab; admin and
 * developer always) may change anything. The frontend locks the other fields with the same table
 * (POST_FG_FE constants/reviewEdit.ts); the server checks it again on submit.
 *
 *   Location not mapped         -> the delivery location
 *   SKU not mapped (line n)     -> our SKU of line n
 *   MRP / Price / Qty mismatch  -> that field of line n
 *   Total mismatch (PO)         -> qty + rate of every line (the total comes from them)
 *   OCR problem (line n)        -> every field of line n;  OCR problem of the PO -> everything
 *   Expired / Other / Duplicate -> nothing to edit (accepted with a remark, as before)
 */

export type LineField = 'pepCode' | 'qty' | 'mrp' | 'rate';
const ALL: LineField[] = ['pepCode', 'qty', 'mrp', 'rate'];

export interface EditRules {
  location: boolean;
  /** Fields open on every line. */
  everyLine: Set<LineField>;
  /** Fields open per line number. */
  lines: Map<string, Set<LineField>>;
}

export const editRules = (open: { issueType: string; lineNo: number | null }[]): EditRules => {
  const r: EditRules = { location: false, everyLine: new Set(), lines: new Map() };
  const line = (n: number, ...f: LineField[]) => {
    const key = String(n);
    if (!r.lines.has(key)) r.lines.set(key, new Set());
    for (const x of f) r.lines.get(key)!.add(x);
  };
  for (const i of open) {
    const n = i.lineNo;
    switch (i.issueType) {
      case ISSUE_TYPE.LOCATION_NOT_MAPPED: r.location = true; break;
      case ISSUE_TYPE.SKU_NOT_MAPPED: if (n !== null) line(n, 'pepCode'); break;
      case ISSUE_TYPE.MRP_MISMATCH: if (n !== null) line(n, 'mrp'); break;
      case ISSUE_TYPE.PRICE_MISMATCH: if (n !== null) line(n, 'rate'); break;
      case ISSUE_TYPE.QTY_MISMATCH: if (n !== null) line(n, 'qty'); else { r.everyLine.add('qty'); } break;
      case ISSUE_TYPE.TOTAL_MISMATCH: r.everyLine.add('qty'); r.everyLine.add('rate'); break;
      case ISSUE_TYPE.OCR_ISSUE:
        if (n !== null) line(n, ...ALL);
        else { r.location = true; for (const f of ALL) r.everyLine.add(f); }
        break;
      default: break;
    }
  }
  return r;
};

export const canEdit = (r: EditRules, lineNo: string, field: LineField): boolean => r.everyLine.has(field) || !!r.lines.get(lineNo)?.has(field);

/** The changes the body asks for that the rules do not open: "location", "line 3 MRP" … (empty = all allowed). */
export const lockedChanges = (
  r: EditRules,
  body: { locationId?: string; lines: ({ lineNo: string } & Partial<Record<LineField, unknown>>)[] },
): string[] => {
  const out: string[] = [];
  if (body.locationId && !r.location) out.push('delivery location');
  const names: Record<LineField, string> = { pepCode: 'SKU', qty: 'qty', mrp: 'MRP', rate: 'rate' };
  for (const c of body.lines) {
    for (const f of ALL) if (c[f] !== undefined && !canEdit(r, c.lineNo, f)) out.push(`line ${c.lineNo} ${names[f]}`);
  }
  return out;
};
