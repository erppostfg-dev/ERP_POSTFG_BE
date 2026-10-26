"""
PO extraction for channels that send one flat CSV: one row per line item, with the PO
header columns repeated on every row (Zepto, TAT), or with no PO columns at all (Flipkart).

No model call. Header columns are listed per channel in channels.json ("header_columns"),
every other column is a line-item column. An empty list means the file has no header
columns. Without a list, columns that hold the same value on every row are taken as
header (needs at least 2 rows).

PO fields that only appear in the file name (Flipkart's Consignment_Details_<PO>_<date>.csv)
are read with the channel's "filename_fields": a regex with one group per field and the
field names, e.g. {"pattern": "^X_(\\d+)\\.csv$", "fields": ["PO Number"]}.

Usage:
    python extract_flat_csv.py <csv>

Paths can be s3://bucket/key or local. Prints the extracted PO as JSON; the log goes to stderr.
"""

import sys
import re
import csv
import io
import json
import time
import contextlib

import boto3
from botocore.exceptions import ClientError, NoCredentialsError

AWS_REGION = "ap-south-1"
ROUNDING_TOLERANCE = 1.0            # rupees per row
MAX_FAILING_SHARE = 0.5             # if more rows than this fail, the formula doesn't fit the layout

# Column names after _norm_col ("Cost_PerUnit_WithGST" -> "cost per unit with gst").
QTY_COLUMNS = ("quantity", "qty", "order qty", "po qty", "ordered qty", "quantity sent")
RATE_COLUMNS = ("landing cost", "landing rate", "cost per unit with gst", "unit cost", "unit price",
                "rate", "unit base cost", "base cost", "basic cost", "cost price")
AMOUNT_COLUMNS = ("total amount", "final amount", "line total", "net amount", "amount")
EAN_COLUMN_RE = re.compile(r"\b(ean|gtin|barcode|upc)\b")
HYPERLINK_RE = re.compile(r'^=HYPERLINK\(\s*"([^"]+)"', re.IGNORECASE)
GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


class PipelineError(RuntimeError):
    """Raised when a run fails (bad file, AWS error)."""


def parse_s3_uri(s3_uri: str) -> tuple:
    bucket, _, key = s3_uri[len("s3://"):].partition("/")
    if not bucket or not key:
        raise ValueError(f"Could not parse bucket/key from S3 path: {s3_uri}")
    return bucket, key


def read_file_bytes(path: str, s3=None) -> bytes:
    if path.startswith("s3://"):
        bucket, key = parse_s3_uri(path)
        s3 = s3 or boto3.client("s3", region_name=AWS_REGION)
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    with open(path, "rb") as f:
        return f.read()


def read_rows(raw: bytes) -> list:
    """CSV rows with blank rows dropped. Handles a BOM, cp1252 files and ; or tab delimiters."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")
    try:
        dialect = csv.Sniffer().sniff(text[:5000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(text), dialect)]
    return [r for r in rows if any(r)]


def _norm_col(name: str) -> str:
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", str(name))      # PoTotalAmount -> Po Total Amount
    name = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", name)          # SKUSize -> SKU Size
    return re.sub(r"[\s_]+", " ", name).strip().lower()


def _to_num(value):
    try:
        return float(str(value).replace(",", "").replace("%", "").strip())
    except ValueError:
        return None


def clean_cell(value: str) -> str:
    """An Excel =HYPERLINK("url", ...) formula becomes just the url."""
    link = HYPERLINK_RE.match(value)
    return link.group(1) if link else value


def split_columns(columns: list, rows: list, header_columns=None) -> tuple:
    """Returns (header column indexes, line-item column indexes, warnings)."""
    warnings = []
    if header_columns is not None:              # [] = no header columns, all line-item columns
        wanted = {_norm_col(c) for c in header_columns}
        names = [_norm_col(c) for c in columns]
        missing = sorted(c for c in header_columns if _norm_col(c) not in names)
        if missing:
            warnings.append(f"Header column(s) listed in channels.json but not in the file: {', '.join(missing)}")
        header_idx = [i for i, n in enumerate(names) if n in wanted]
    elif len(rows) >= 2:
        print("  [Columns] no header_columns for this channel, using columns that are the same on every row")
        header_idx = [i for i in range(len(columns)) if len({r[i] for r in rows}) == 1]
    else:
        warnings.append("Only one row and no header_columns configured: every column is treated as a line-item column.")
        header_idx = []
    item_idx = [i for i in range(len(columns)) if i not in header_idx]
    return header_idx, item_idx, warnings


def read_header(columns: list, rows: list, header_idx: list) -> tuple:
    """One field per header column. Returns (fields, warnings)."""
    fields, warnings, blank = [], [], []
    for i in header_idx:
        values = [clean_cell(r[i]) for r in rows]
        distinct = list(dict.fromkeys(v for v in values if v))
        if len(distinct) > 1:
            warnings.append(f"Header column '{columns[i]}' differs between rows ({', '.join(distinct[:3])}), "
                            f"the file may hold more than one PO. Using the first value.")
        if not distinct:
            blank.append(columns[i])
            continue
        note = " (url from HYPERLINK formula)" if HYPERLINK_RE.match(rows[0][i]) else ""
        fields.append({"field": columns[i], "value": distinct[0], "confidence": f"exact (from CSV){note}"})
    if blank:
        print(f"  [Header] dropped {len(blank)} blank column(s): {', '.join(blank)}")
    return fields, warnings


def read_filename_fields(path: str, filename_fields: dict) -> tuple:
    """Header fields taken from the file name (local or s3:// path). Returns (fields, warnings)."""
    name = re.split(r"[\\/]", path)[-1]
    try:
        pattern = re.compile(filename_fields["pattern"], re.IGNORECASE)
        names = list(filename_fields["fields"])
    except (KeyError, TypeError, re.error) as e:
        raise PipelineError(f"bad filename_fields in channels.json: {e}") from e
    if pattern.groups != len(names):
        raise PipelineError(f"bad filename_fields in channels.json: the pattern has {pattern.groups} "
                            f"group(s) but {len(names)} field name(s)")
    match = pattern.search(name)
    if not match:
        return [], [f"File name '{name}' doesn't match the expected pattern {filename_fields['pattern']}, "
                    f"so {', '.join(names)} could not be read from it."]
    fields = [{"field": f, "value": v, "confidence": "exact (from file name)"}
              for f, v in zip(names, match.groups()) if v]
    print("  [File name] " + ", ".join(f"{f['field']}={f['value']}" for f in fields))
    return fields, []


def validate_line_items(columns: list, rows: list) -> tuple:
    """Qty x Rate (with or without the row's tax %) must give the line amount."""
    names = [_norm_col(c) for c in columns]
    qty_idx = next((names.index(c) for c in QTY_COLUMNS if c in names), None)
    rate_idxs = [names.index(c) for c in RATE_COLUMNS if c in names]
    amount_idx = next((names.index(c) for c in AMOUNT_COLUMNS if c in names), None)
    if qty_idx is None or amount_idx is None or not rate_idxs:
        return [], "row arithmetic check: skipped (no Qty / Rate / Amount columns found by name)"

    def tax_pct(row):
        pct = {n.split()[0]: _to_num(row[i]) or 0 for i, n in enumerate(names)
               if re.match(r"^(igst|cgst|sgst|utgst)( percentage| %|%)?$", n)}
        return pct.get("igst") or (pct.get("cgst", 0) + pct.get("sgst", pct.get("utgst", 0)))

    checked, failures = 0, []
    for r, row in enumerate(rows, start=1):
        qty, amount = _to_num(row[qty_idx]), _to_num(row[amount_idx])
        if not qty or amount is None:
            continue
        candidates = []
        for i in rate_idxs:
            rate = _to_num(row[i])
            if rate is not None:
                candidates += [qty * rate, qty * rate * (1 + tax_pct(row) / 100)]
        if not candidates:
            continue
        checked += 1
        if not any(abs(amount - c) <= max(ROUNDING_TOLERANCE, abs(amount) * 0.001) for c in candidates):
            failures.append(f"Row {r}: {columns[qty_idx]}({row[qty_idx]}) x {columns[rate_idxs[0]]}"
                            f"({row[rate_idxs[0]]}) doesn't give {columns[amount_idx]} {row[amount_idx]}")
    if not checked:
        return [], "row arithmetic check: skipped (no numeric rows)"
    if len(failures) > MAX_FAILING_SHARE * checked and checked >= 3:
        return [], (f"row arithmetic check: not applied ({len(failures)} of {checked} rows fit no formula, "
                    f"this layout computes amounts differently)")
    return failures, f"row arithmetic check: {checked - len(failures)} of {checked} rows OK"


def computed_totals(columns: list, rows: list) -> list:
    """Totals summed from the line items (flat CSVs print none of their own, apart from Zepto's PO total)."""
    names = [_norm_col(c) for c in columns]
    totals = [{"field": "Total Items", "value": str(len(rows)), "confidence": "computed (count of line items)"}]
    for label, options in (("Total Quantity", QTY_COLUMNS), ("Total Amount", AMOUNT_COLUMNS)):
        idx = next((names.index(c) for c in options if c in names), None)
        values = [_to_num(r[idx]) for r in rows] if idx is not None else []
        if values and all(v is not None for v in values):
            total = round(sum(values), 2)
            totals.append({"field": label, "value": f"{total:g}" if total == int(total) else f"{total:.2f}",
                           "confidence": f"computed (sum of {columns[idx]})"})
    return totals


def gstin_check_digit_ok(gstin: str) -> bool:
    total = 0
    for i, ch in enumerate(gstin[:14]):
        value = GSTIN_CHARSET.index(ch) * (2 if i % 2 else 1)
        total += value // 36 + value % 36
    return GSTIN_CHARSET[(36 - total % 36) % 36] == gstin[14]


def ean13_ok(code: str) -> bool:
    if not re.fullmatch(r"[0-9]{13}", code):
        return True                 # not an EAN-13, nothing to check
    digits = [int(d) for d in code]
    return (10 - sum(d * (3 if i % 2 else 1) for i, d in enumerate(digits[:12])) % 10) % 10 == digits[12]


def validate(header_fields: list, totals: list, columns: list, rows: list) -> list:
    warnings = []
    for f in header_fields:
        value = f["value"]
        if re.fullmatch(r"[0-9]{2}[A-Z0-9]{13}", value.upper()):
            if not GSTIN_RE.match(value.upper()):
                warnings.append(f"GSTIN '{f['field']}' = '{value}' doesn't match the GSTIN format.")
            elif not gstin_check_digit_ok(value.upper()):
                warnings.append(f"GSTIN '{f['field']}' = '{value}' fails its check digit.")

    names = [_norm_col(c) for c in columns]
    for i, n in enumerate(names):
        if EAN_COLUMN_RE.search(n):
            bad = [r[i] for r in rows if r[i] and not ean13_ok(r[i])]
            if bad:
                warnings.append(f"'{columns[i]}' fails the EAN-13 check digit: {', '.join(bad[:5])}")

    # A PO total printed in the file must equal the sum of the line amounts.
    computed = next((t for t in totals if t["field"] == "Total Amount"), None)
    for f in header_fields:
        lname = _norm_col(f["field"])
        if computed and "total" in lname and "amount" in lname and _to_num(f["value"]) is not None:
            diff = abs(_to_num(f["value"]) - _to_num(computed["value"]))
            if diff > max(0.05, 0.01 * len(rows)):
                warnings.append(f"'{f['field']}' = {f['value']}, but the line items add up to {computed['value']}")
            else:
                print(f"  [Totals] '{f['field']}' {f['value']} matches the line items ({computed['value']})")
    return warnings


def _unique(names: list) -> list:
    """Repeated column names get a number ("Qty", "Qty 2") so no value is lost in a dict."""
    seen, out = {}, []
    for name in names:
        seen[name] = seen.get(name, 0) + 1
        out.append(name if seen[name] == 1 else f"{name} {seen[name]}")
    return out


def build_output(header_fields: list, totals: list, line_columns: list, line_rows: list, warnings: list) -> dict:
    """The raw extraction: header and totals keyed by column name, one dict per line item."""
    return {
        "header": {f["field"]: f["value"] for f in header_fields},
        "totals": {t["field"]: t["value"] for t in totals},
        "line_item_columns": line_columns,
        "line_items": [dict(zip(line_columns, row)) for row in line_rows],
        "warnings": warnings,
    }


def process(sheet_path: str, clients: dict = None, header_columns: list = None,
            filename_fields: dict = None) -> dict:
    """Runs the pipeline on one flat CSV and returns the extracted data as a dict. Raises PipelineError."""
    started = time.time()
    print(f"Reading {sheet_path}\n")

    try:
        rows = read_rows(read_file_bytes(sheet_path, (clients or {}).get("s3")))
    except NoCredentialsError as e:
        raise PipelineError("No AWS credentials found. Run `aws configure` first.") from e
    except ClientError as e:
        raise PipelineError(f"{e.response.get('Error', {}).get('Code', 'Unknown')} - {e}") from e
    except (OSError, ValueError, UnicodeDecodeError) as e:
        raise PipelineError(str(e)) from e
    if len(rows) < 2:
        raise PipelineError("The CSV has no data rows.")

    columns, data = _unique(rows[0]), rows[1:]
    width = len(columns)
    data = [(r + [""] * width)[:width] for r in data]
    print(f"  [CSV] {width} columns, {len(data)} row(s)")

    header_idx, item_idx, warnings = split_columns(columns, data, header_columns)
    header_fields, header_warnings = read_header(columns, data, header_idx)
    warnings += header_warnings
    if filename_fields:
        name_fields, name_warnings = read_filename_fields(sheet_path, filename_fields)
        header_fields = name_fields + header_fields
        warnings += name_warnings

    line_columns = [columns[i] for i in item_idx]
    line_rows = [[clean_cell(r[i]) for i in item_idx] for r in data]
    totals = computed_totals(line_columns, line_rows)

    row_warnings, arithmetic = validate_line_items(line_columns, line_rows)
    print(f"  [Line items] {arithmetic}")
    warnings += row_warnings + validate(header_fields, totals, line_columns, line_rows)

    print(f"\nExtracted {len(header_fields)} header field(s), {len(line_rows)} line item(s), "
          f"{len(totals)} computed total(s). No model call, cost $0.")
    if warnings:
        print(f"Validation: {len(warnings)} issue(s) to review:")
        for w in warnings:
            print(f"  - {w}")
    else:
        print("Validation: no issues.")

    print(f"Took {time.time() - started:.1f}s")
    return build_output(header_fields, totals, line_columns, line_rows, warnings)


def main():
    if len(sys.argv) != 2:
        print("Usage: python extract_flat_csv.py <csv>")
        sys.exit(1)
    try:
        with contextlib.redirect_stdout(sys.stderr):      # log to stderr, JSON alone on stdout
            result = process(sys.argv[1])
    except PipelineError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    sys.stdout.reconfigure(encoding="utf-8")       # Windows defaults to cp1252 when redirected
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
