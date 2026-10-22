"""
PO extraction for channels that send line items as a spreadsheet next to the PDF
(Blinkit, Myntra, Slikk, Gluzo).

Header fields come from page 1 of the PDF. If the page has a usable text layer we send
that text to the model (TEXT mode) and check every value against it; otherwise page 1
is rendered and sent as an image (VISION mode). Line items and footer totals are read
straight from the xlsx/xls/csv/tsv file (converted to CSV first), then checked against
each other. Header values also go through PAN/GSTIN/phone/pincode format checks.

Usage:
    python extract_text_first_excel_v2.py <pdf> <line-items file>

Paths can be s3://bucket/key or local. Prints the extracted PO as JSON; the log goes to stderr.

Needs: pip install boto3 pymupdf openpyxl (plus xlrd for old .xls), and aws configure.
"""

import os
import sys
import re
import time
import json
import csv
import io
import contextlib
import boto3
import openpyxl
from botocore.config import Config
from botocore.exceptions import ClientError, NoCredentialsError

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz         # older PyMuPDF
    except ImportError:
        fitz = None

AWS_REGION = "ap-south-1"           # S3

BEDROCK_REGION = "ap-south-1"
# Qwen3 VL handles both text and images, and is available in Mumbai without Marketplace.
BEDROCK_MODEL_ID = "qwen.qwen3-vl-235b-a22b"
BEDROCK_MAX_TOKENS = 8000           # model limit, higher gets rejected
TEMPERATURE = 0.0                   # keeps field names stable between runs

# Mumbai on-demand pricing, only used for the cost printout.
MODEL_INPUT_COST_PER_M = 0.62       # USD per 1M input tokens
MODEL_OUTPUT_COST_PER_M = 3.13      # USD per 1M output tokens

# Totals come from the spreadsheet, so only page 1 is needed.
HEADER_PAGE_INDICES = [0]
VISION_IMAGE_DPI = 300

# "auto", "text" or "vision"
HEADER_MODE = "auto"

# --- text layer health check ---
MIN_TEXT_CHARS = 100                # non-space chars
MIN_ALNUM_RATIO = 0.5               # below this the text is probably garbled
MAX_INVISIBLE_RATIO = 0.5           # invisible text usually means an OCR layer over a scan
MAX_IMAGE_COVERAGE = 0.9            # a single image this big means a scanned page
MIN_PO_KEYWORDS = 2
PO_KEYWORDS = ("po", "order", "purchase", "gst", "gstin", "vendor", "supplier", "date",
               "deliver", "delivery", "ship", "bill", "pan", "qty", "quantity", "total",
               "str", "stn", "transfer")

ROUNDING_TOLERANCE = 1.0            # rupees per row, some POs round to whole rupees
MAX_FAILING_SHARE = 0.5             # if more rows fail than this, the formula doesn't fit the layout


def make_clients() -> dict:
    config = Config(retries={"max_attempts": 10, "mode": "adaptive"}, read_timeout=600)
    return {
        "s3": boto3.client("s3", region_name=AWS_REGION, config=config),
        "bedrock": boto3.client("bedrock-runtime", region_name=BEDROCK_REGION, config=config),
    }


def parse_s3_uri(s3_uri: str) -> tuple:
    without_prefix = s3_uri[len("s3://"):]
    bucket, _, key = without_prefix.partition("/")
    if not bucket or not key:
        raise ValueError(f"Could not parse bucket/key from S3 path: {s3_uri}")
    return bucket, key


def read_file_bytes(s3, path: str) -> bytes:
    if path.startswith("s3://"):
        bucket, key = parse_s3_uri(path)
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    with open(path, "rb") as f:
        return f.read()


# --- line-items file to CSV ---

XLSX_SIGNATURE = b"PK\x03\x04"                            # zip
XLS_SIGNATURE = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"       # OLE
TEXT_EXTENSIONS = ("csv", "tsv", "txt")
SUPPORTED_EXTENSIONS = ("xlsx", "xlsm", "xls") + TEXT_EXTENSIONS


def detect_format(path: str, data: bytes) -> str:
    """Return "xlsx", "xls", "tsv" or "csv". Content is checked before the extension,
    since portals often send tab-separated text named .xls."""
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext and ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported line-items file type '.{ext}' "
                         f"(supported: {', '.join('.' + e for e in SUPPORTED_EXTENSIONS)})")

    if data[:4] == XLSX_SIGNATURE:
        fmt = "xlsx"
    elif data[:8] == XLS_SIGNATURE:
        fmt = "xls"
    elif ext == "tsv":
        fmt = "tsv"
    else:
        fmt = "csv"

    if ext and ext not in (fmt, "xlsm", "txt"):
        print(f"  [Input] extension is .{ext} but content is {fmt.upper()}, reading as {fmt.upper()}")
    return fmt


RUPEE_AMOUNT = re.compile(r"^₹\s*(-?[\d,]+(?:\.\d+)?)$")


def cell_to_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    amount = RUPEE_AMOUNT.match(text)           # Gluzo: "₹        263.75" -> "263.75"
    return amount.group(1) if amount else text


def xlsx_to_rows(data: bytes) -> list:
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    try:
        ws = wb.worksheets[0]
        return [[cell_to_str(v) for v in row] for row in ws.iter_rows(values_only=True)]
    finally:
        wb.close()


def xls_to_rows(data: bytes) -> list:
    try:
        import xlrd
    except ImportError:
        raise RuntimeError("xlrd is required to read .xls files. Run: pip install xlrd")
    sheet = xlrd.open_workbook(file_contents=data).sheet_by_index(0)
    return [[cell_to_str(sheet.cell_value(r, c)) for c in range(sheet.ncols)]
            for r in range(sheet.nrows)]


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def text_to_rows(data: bytes, fmt: str) -> list:
    text = decode_text(data)
    if fmt == "tsv":
        delimiter = "\t"
    else:
        try:
            delimiter = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text), delimiter=delimiter)]


def convert_to_csv(path: str, data: bytes) -> tuple:
    """Convert any supported format to CSV text so there's only one parser."""
    fmt = detect_format(path, data)
    if fmt == "xlsx":
        rows = xlsx_to_rows(data)
    elif fmt == "xls":
        rows = xls_to_rows(data)
    else:
        rows = text_to_rows(data, fmt)

    buffer = io.StringIO()
    csv.writer(buffer).writerows(rows)
    return fmt, buffer.getvalue()


# --- line items and totals ---

def is_number(value: str) -> bool:
    try:
        float(value.replace(",", "").strip())
        return True
    except ValueError:
        return False


def read_line_items_from_csv(csv_text: str) -> dict:
    """Blinkit-style layout: header row, item rows with a serial no. in column 1,
    then footer rows (empty column 1) holding label/value pairs like Total Quantity."""
    all_rows = list(csv.reader(io.StringIO(csv_text)))

    # first row with 3+ filled cells and no numbers
    header_idx = None
    for i, row in enumerate(all_rows):
        filled = [v for v in row if v.strip()]
        if len(filled) >= 3 and not any(is_number(v) for v in filled):
            header_idx = i
            break
    if header_idx is None:
        raise RuntimeError("Could not find a header row in the line-items file.")

    header = all_rows[header_idx]
    last_col = max(i for i, v in enumerate(header) if v.strip())
    columns = [v.strip() for v in header[:last_col + 1]]

    rows, totals = [], []
    for row in all_rows[header_idx + 1:]:
        if not any(v.strip() for v in row):
            continue
        if row[0].strip():
            padded = row + [""] * (last_col + 1 - len(row))
            rows.append([v.strip() for v in padded[:last_col + 1]])
            continue
        # footer row
        for j in range(len(row) - 1):
            label, value = row[j].strip(), row[j + 1].strip()
            if label and not is_number(label) and value and is_number(value):
                totals.append({"field": label, "value": value})

    return {"columns": columns, "rows": rows, "totals": totals}


def reconcile_totals(columns: list, rows: list, totals: list, tolerance: float = 0.01) -> list:
    """Compare the footer totals with the line items."""
    warnings = []
    lookup = {t["field"].lower(): t["value"] for t in totals}

    def to_num(v):
        try:
            return float(str(v).replace(",", "").strip())
        except (ValueError, TypeError):
            return None

    def col_sum(*names):
        for i, col in enumerate(columns):
            if col.lower() in names:
                values = [to_num(r[i]) for r in rows if i < len(r)]
                return sum(v for v in values if v is not None)
        return None

    checks = [
        ("total items", float(len(rows))),
        ("total quantity", col_sum("quantity", "qty", "qty.")),
        ("total amount", col_sum("total amount", "total amt")),
    ]
    for label, actual in checks:
        expected = to_num(lookup.get(label))
        if expected is None or actual is None:
            continue
        if abs(expected - actual) > tolerance:
            warnings.append(f"File footer '{label.title()}' = {expected:g}, "
                            f"but line items add up to {actual:.2f}")
    return warnings


def check_pdf_totals(header_fields: list, columns: list, rows: list, pdf_totals: dict) -> tuple:
    """
    Totals printed in the PDF (read by the model as header fields) checked against the
    line-items file. pdf_totals is a channel setting: {"<header field>": "<column to sum>"},
    e.g. {"Total Quantity": "Allocate qty"}. Matched fields move from the header to the
    totals. Returns (header_fields, totals, warnings).
    """
    names = [_norm_col(c) for c in columns]
    by_name = {_norm_col(f.get("field", "")): f for f in header_fields}
    totals, warnings, moved = [], [], []
    for field, column in pdf_totals.items():
        found = by_name.get(_norm_col(field))
        if found is None:
            warnings.append(f"PDF total '{field}' was not returned by the model, so it isn't checked "
                            f"against the '{column}' column.")
            continue
        moved.append(id(found))
        totals.append({"field": field, "value": found.get("value", "")})
        expected = to_num(found.get("value"))
        if _norm_col(column) not in names:
            warnings.append(f"PDF total '{field}': no '{column}' column in the line-items file to check it against.")
            continue
        idx = names.index(_norm_col(column))
        values = [v for v in (to_num(r[idx]) for r in rows if idx < len(r)) if v is not None]
        actual = sum(values)
        tolerance = 0.001 if _norm_col(column) in QTY_COLUMNS else max(0.05, 0.01 * len(values))
        if expected is None or abs(expected - actual) > tolerance:
            warnings.append(f"PDF total '{field}' = {found.get('value')}, but the '{column}' column "
                            f"adds up to {actual:,.2f}")
        else:
            print(f"  [Totals] PDF '{field}' {found.get('value')} matches the sum of '{column}'")
    return [f for f in header_fields if id(f) not in moved], totals, warnings


# Column names for the row arithmetic check (lower-cased, spaces collapsed).
# Billed qty is listed before total qty because total can include free units.
QTY_COLUMNS = ("qty", "qty.", "quantity", "billed qty", "billed quantity", "order qty", "ordered qty",
               "po qty", "invoice qty", "total qty", "allocate qty", "ordered quantity")
RATE_COLUMNS = ("supplier price", "rate/unit", "rate", "unit rate", "unit price", "landing rate",
                "landing cost", "landed price", "landed cost", "basic cost price", "basic cost",
                "base cost", "cost price", "list price", "price", "purchase price/pu",
                "base price", "item price")
AMOUNT_COLUMNS = ("total amount", "total value", "amount (inr)", "amount", "total amt", "total amt.",
                  "net amount", "line total", "total", "total purchase price with gst")
TAXABLE_COLUMNS = ("taxable value", "taxable amount", "taxable amt", "total purchase price")
# Tax amount columns like "IGST Value", "Tax Amt" or bare "IGST". A combined
# "GST Amount" is left out on purpose, it would double-count the tax; Slikk's
# "Total GST Value" and Gluzo's "Included Tax" are allowed since those sheets have no
# per-tax columns.
TAX_VALUE_COLUMN_RE = re.compile(r"^(igst|cgst|sgst|utgst|cess)\b.*\b(value|amt\.?|amount)$"
                                 r"|^tax (amt\.?|amount)$|^(igst|cgst|sgst|utgst)$"
                                 r"|^total gst value$|^included tax$")
TAX_PERCENT_COLUMN_RE = re.compile(r"^(igst|cgst|sgst|utgst|cess)\b.*(%|rate)$")
CURRENCY_TOKENS = re.compile(r"\bINR\b|₹|\bRs\.?", re.IGNORECASE)


def to_num(value):
    """Parse '7611.84 INR', '1,234', '18.0%' or '₹210986.64*' as a float, else None."""
    text = CURRENCY_TOKENS.sub("", str(value)).replace(",", "").replace("%", "").strip().rstrip("*").strip()
    try:
        return float(text)
    except ValueError:
        return None


def _norm_col(name: str) -> str:
    return re.sub(r"\s+", " ", str(name).strip().lower())


def validate_line_items(columns: list, rows: list) -> tuple:
    """Per-row arithmetic check, run as two separate checks.

    Rate: amount = qty x rate, optionally plus tax values or times (1 + tax %).
    Taxable: amount = taxable value + tax (or x (1 + tax %)).
    If most rows fail a check we assume the layout is different and just note it.
    Returns (warnings, summary).
    """
    names = [_norm_col(c) for c in columns]
    qty_idx = next((names.index(c) for c in QTY_COLUMNS if c in names), None)
    rate_idxs = [names.index(c) for c in RATE_COLUMNS if c in names]
    amount_idxs = [names.index(c) for c in AMOUNT_COLUMNS if c in names]
    taxable_idx = next((names.index(c) for c in TAXABLE_COLUMNS if c in names), None)
    tax_value_idxs = [i for i, n in enumerate(names) if TAX_VALUE_COLUMN_RE.search(n)]
    tax_pct_idxs = [i for i, n in enumerate(names) if TAX_PERCENT_COLUMN_RE.search(n)]
    if qty_idx is None or not amount_idxs or not (rate_idxs or taxable_idx is not None):
        return [], "row arithmetic check: skipped (no Qty / Rate / Amount columns found by name)"

    def cell(row, i):
        return to_num(row[i]) if i is not None and i < len(row) else None

    def fits(amounts, candidates):
        return any(abs(a - c) <= max(ROUNDING_TOLERANCE, abs(a) * 0.001) for a in amounts for c in candidates)

    def decimal_hint(amounts, candidates):
        return (" (looks like a misplaced decimal point)"
                if any(c and abs(a / c - f) < 0.02 * f
                       for a in amounts for c in candidates for f in (10, 100, 0.1, 0.01)) else "")

    checks = {"rate": {"checked": 0, "failures": []}, "taxable": {"checked": 0, "failures": []}}
    for r, row in enumerate(rows, start=1):
        qty = cell(row, qty_idx)
        amounts = [a for a in (cell(row, ai) for ai in amount_idxs) if a is not None]
        if not qty or not amounts:
            continue
        tax_values = sum(v for v in (cell(row, i) for i in tax_value_idxs) if v is not None)
        tax_pct = sum(v for v in (cell(row, i) for i in tax_pct_idxs) if v is not None)
        amount_desc = f"{columns[amount_idxs[0]]} {row[amount_idxs[0]]}"

        rate_candidates = []
        for ri in rate_idxs:
            rate = cell(row, ri)
            if rate is not None:
                base = qty * rate
                rate_candidates += [base, base + tax_values, base * (1 + tax_pct / 100)]
        if rate_candidates:
            checks["rate"]["checked"] += 1
            if not fits(amounts, rate_candidates):
                checks["rate"]["failures"].append(
                    f"Row {r}: Qty({row[qty_idx]}) x {columns[rate_idxs[0]]}({row[rate_idxs[0]]}) doesn't give "
                    f"{amount_desc} with or without tax{decimal_hint(amounts, rate_candidates)}")

        taxable = cell(row, taxable_idx)
        if taxable is not None:
            taxable_candidates = [taxable + tax_values, taxable * (1 + tax_pct / 100)]
            checks["taxable"]["checked"] += 1
            if not fits(amounts, taxable_candidates):
                checks["taxable"]["failures"].append(
                    f"Row {r}: {columns[taxable_idx]}({row[taxable_idx]}) + tax doesn't give "
                    f"{amount_desc}{decimal_hint(amounts, taxable_candidates)}")

    warnings, notes = [], []
    for label, c in (("Qty x Rate", checks["rate"]), ("Taxable + tax", checks["taxable"])):
        if not c["checked"]:
            continue
        if len(c["failures"]) > MAX_FAILING_SHARE * c["checked"] and c["checked"] >= 3:
            notes.append(f"{label}: not applied ({len(c['failures'])} of {c['checked']} rows fit no formula, "
                         f"layout probably computes amounts differently)")
        else:
            warnings += c["failures"]
            notes.append(f"{label}: {c['checked'] - len(c['failures'])} of {c['checked']} rows OK")
    if not notes:
        return [], "row arithmetic check: skipped (no numeric rows)"
    return warnings, "row arithmetic check: " + "; ".join(notes)


# --- text layer check ---

def assess_text_layer(pdf_bytes: bytes) -> tuple:
    """Return (usable, reason, page1_text). Usable means real digital text, not a
    scan, an OCR layer or broken font encoding."""
    if fitz is None:
        raise RuntimeError("pymupdf is required to read the PDF. Run: pip install pymupdf")

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        text = page.get_text()

        non_space = [c for c in text if not c.isspace()]
        if len(non_space) < MIN_TEXT_CHARS:
            return False, f"only {len(non_space)} characters of text, probably a scan", text

        garbled = text.count("�") + len(re.findall(r"\(cid:\d+\)", text))
        alnum_ratio = sum(c.isalnum() for c in non_space) / len(non_space)
        if garbled or alnum_ratio < MIN_ALNUM_RATIO:
            return False, (f"text looks garbled ({garbled} unreadable glyph(s), "
                           f"{alnum_ratio:.0%} letters/digits), broken font encoding"), text

        # OCR layers on scans use invisible text (render mode 3) and can carry OCR errors.
        char_types = [span["type"] for span in page.get_texttrace() for _ in span["chars"]]
        if char_types:
            invisible_ratio = char_types.count(3) / len(char_types)
            if invisible_ratio > MAX_INVISIBLE_RATIO:
                return False, (f"{invisible_ratio:.0%} of the text is invisible, looks like an OCR layer "
                               f"over a scan"), text

        page_area = page.rect.width * page.rect.height
        for info in page.get_image_info():
            x0, y0, x1, y1 = info["bbox"]
            coverage = (x1 - x0) * (y1 - y0) / page_area if page_area else 0
            if coverage >= MAX_IMAGE_COVERAGE:
                return False, f"one image covers {coverage:.0%} of the page, probably a scan", text

        words = set(re.findall(r"[a-z]+", text.lower()))
        found = [k for k in PO_KEYWORDS if k in words]
        if len(found) < MIN_PO_KEYWORDS:
            return False, f"text doesn't look like a PO (keywords found: {found or 'none'})", text

        return True, (f"{len(non_space)} characters of digital text, {alnum_ratio:.0%} letters/digits, "
                      f"PO keywords: {', '.join(found[:6])}"), text
    finally:
        doc.close()


def last_page_text(pdf_bytes: bytes) -> str:
    """Text of the last page, "" for a one-page PDF (used when totals print at the end)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return doc[-1].get_text() if doc.page_count > 1 else ""
    finally:
        doc.close()


def render_header_pages_to_png(pdf_bytes: bytes, dpi: int = VISION_IMAGE_DPI,
                               read_last_page: bool = False) -> list:
    if fitz is None:
        raise RuntimeError("pymupdf is required for vision extraction. Run: pip install pymupdf")

    images = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    zoom = dpi / 72
    matrix = fitz.Matrix(zoom, zoom)
    try:
        indices = list(HEADER_PAGE_INDICES)
        if read_last_page and doc.page_count - 1 not in indices:
            indices.append(doc.page_count - 1)
        for idx in indices:
            if 0 <= idx < doc.page_count:
                pix = doc[idx].get_pixmap(matrix=matrix)
                images.append(pix.tobytes("png"))
    finally:
        doc.close()
    return images


# --- header fields (model call) ---

# shared by TEXT and VISION prompts
HEADER_RULES = """WHAT TO EXTRACT
Every labelled business field in the header area, for example: buyer / company name, PAN, CIN, \
GSTIN / GST No., warehouse or facility name, contact names, phone numbers, emails, vendor name, \
vendor number / code, vendor address, PO number (for stock transfers: STR / STN / STO number), \
PO date, PO type, PO expiry date, delivery date, currency, payment terms, delivered-by / \
ship-from details, delivered-to / ship-to / bill-to details, SPOC details, reference numbers.

WHAT NOT TO EXTRACT
- The line-items table (product rows) and anything below it.
- Totals and summary amounts (Total Quantity, Total Amount, Net Amount, Cart Discount, etc.) — \
they are taken from a separate file.
- Terms & conditions, remarks, notes, signature blocks, page numbers, logos.

HOW TO PAIR LABELS WITH VALUES
- A value belongs to the label printed immediately before it, usually separated by ":".
- Header boxes are often laid out in two or more columns side by side. Read each column top to \
bottom on its own; never combine text from neighbouring columns into one value.
- A label may be wrapped onto two lines (e.g. "Delivered" / "By", "PO delivery" / "date") — \
treat it as one label.
- Every label is its own field. Never put two labels' values into one field. If a value you \
are writing would run into the next label's value (e.g. a PO number followed by a date), stop — \
that is two separate fields.
- If a label has no value printed after it (e.g. "Reference :" followed by nothing), omit it.
- When the same label appears in different blocks (e.g. "PAN", "GST No.", "Address" for both \
the buyer and the vendor), name each after its block: "Buyer PAN", "Vendor PAN", \
"Delivered To GST No.", "Delivered By Address", etc.
- A PO usually prints MORE THAN ONE GST No. / GSTIN — typically the vendor's (often in a \
right-hand box next to Payment Terms, PO expiry or delivery dates) and the buyer's (next to \
Delivered To / Ship To / Bill To). Return EVERY GST No. printed on the page, each named after \
the party it belongs to (e.g. "Vendor GST No.", "Delivered To GST No."). Before answering, scan \
the whole header once more — every box, including right-hand columns — and make sure no \
labelled value has been skipped.
- Every GSTIN, PAN and CIN printed in the header must be returned as its own field.
- An address block often starts with a line that is only the location's NAME (e.g. a \
warehouse or facility name), followed by the street address lines. Return that first line as \
"<Block> Name" and the remaining lines as "<Block> Address".
- Every field name must be unique — never return the same name twice.
- A value may start with a leftover label fragment (e.g. "GST: 27ABCDE1234F1Z5"); return only \
the value itself.

COPY VALUES EXACTLY AS PRINTED
- Character for character: same spelling, capitalisation, spaces and punctuation. Do not add, \
remove or "correct" punctuation, do not expand abbreviations, do not reformat dates or numbers.
- Keep the spaces between words in names and addresses.
- A value printed over several lines (address, contact details, list of emails) becomes ONE \
value with the lines joined by a single space. If a single word or email address is broken \
across two lines (e.g. "mcaffeine.co" then "m"), join the pieces with no space.

CODES AND NUMBERS — READ THEM ONE CHARACTER AT A TIME
IDs are the most important values: PO number (or STR / STN / STO number), vendor number, PAN, \
GSTIN, CIN, phone numbers, pincodes. For each one:
1. Read it one character at a time, left to right.
2. Count the characters and compare with the expected length below, where one exists.
3. Never insert, drop, repeat or swap characters. A PO / STR number is one unbroken string — it \
never contains spaces, words or a date.
Look-alike characters (0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B) must be decided by the character's \
POSITION in the code's format below, not by its shape alone.

Known formats — use them to check your reading:
- PAN: exactly 10 characters = 5 letters, then 4 digits, then 1 letter (e.g. ABCDE1234F). \
Characters 6 to 9 are ALWAYS digits.
- GSTIN / GST No.: exactly 15 characters = 2-digit state code + the company's 10-character PAN \
+ 1 digit or letter + the letter "Z" + 1 digit or letter (e.g. 27ABCDE1234F1Z5). Characters 3 \
to 12 of a GSTIN ARE the PAN of the same company: when the page shows both a company's PAN and \
its GSTIN, they must agree character for character — if they don't, re-read both.
- CIN: exactly 21 characters (e.g. U74140HR2015FTC055568).
- Indian phone numbers: 10 digits, possibly with a "91-" or "+91" prefix. Pincodes: 6 digits.
- Dates: copy exactly as printed, including the time if one is printed.

CONFIDENCE
For each field report "high", "medium" or "low":
- "high" only if every character is clearly legible AND the value passes its format check above.
- "medium" if any character was hard to read or you had to choose between look-alike characters.
- "low" if part of the value is unclear or it still fails its format check after re-reading.

OUTPUT
Return ONLY valid JSON — no markdown fences, no commentary — in exactly this shape:
{"header_fields": [{"field": "<field name in Title Case>", "value": "<value exactly as printed>", "confidence": "high|medium|low"}]}
List the fields in the order they appear on the page. If a value cannot be read at all, omit \
the field rather than guessing.
"""

VISION_MODE_INTRO = """You are reading the attached image of page 1 of a Purchase Order (PO) and \
extracting its HEADER fields. Every character matters: these values are loaded into an ERP \
system without anyone re-typing them, so one wrong digit in a PO number or GSTIN breaks the order.

"""

TEXT_MODE_INTRO = """You are extracting the HEADER fields of a Purchase Order (PO) or Stock Transfer \
document. Below is the embedded text layer of page 1, extracted by a PDF library — these are the \
document's exact characters, nothing has been misread, so copy values character for character. \
The text follows the PDF's internal order, which differs from how the page looks:
- A label and its value are often on separate lines (e.g. "P.O. Number" then ": 2273910106296").
- A label may be split over several lines (e.g. "Delivered" / "By", "PO delivery" / "date").
- Boxes that sit side by side on the page may appear one after the other.
- Long values (addresses, contact details, email lists) are broken across lines — join them.
- The text also contains the line-items table and terms & conditions — ignore those.

"""

VISION_HEADER_PROMPT = VISION_MODE_INTRO + HEADER_RULES


def channel_notes_block(header_notes: str = None) -> str:
    """Per-channel layout notes from channels.json, added after the general rules."""
    if not header_notes:
        return ""
    return ("\nCHANNEL-SPECIFIC NOTES FOR THIS PO LAYOUT — follow these exactly; they "
            f"override the general rules above where they differ:\n{header_notes.strip()}\n")


def build_text_mode_prompt(page_text: str, header_notes: str = None, last_text: str = "") -> str:
    prompt = (TEXT_MODE_INTRO + HEADER_RULES + channel_notes_block(header_notes)
              + "\n--- PAGE 1 TEXT LAYER ---\n" + page_text.strip() + "\n--- END OF PAGE 1 TEXT ---\n")
    if last_text.strip():
        prompt += ("\n--- LAST PAGE TEXT LAYER (read it only for the PO totals) ---\n"
                   + last_text.strip() + "\n--- END OF LAST PAGE TEXT ---\n")
    return prompt


def call_model_for_header(bedrock, content_blocks: list, label: str) -> dict:
    response = bedrock.converse(
        modelId=BEDROCK_MODEL_ID,
        messages=[{"role": "user", "content": content_blocks}],
        inferenceConfig={"maxTokens": BEDROCK_MAX_TOKENS, "temperature": TEMPERATURE},
    )

    output_blocks = response["output"]["message"]["content"]
    response_text = "".join(b.get("text", "") for b in output_blocks).strip()

    usage = response.get("usage", {})
    input_tokens = usage.get("inputTokens", 0)
    output_tokens = usage.get("outputTokens", 0)
    cost = (input_tokens / 1_000_000 * MODEL_INPUT_COST_PER_M) + \
           (output_tokens / 1_000_000 * MODEL_OUTPUT_COST_PER_M)
    print(f"  [Header | {BEDROCK_MODEL_ID}, {label}] tokens: "
          f"{input_tokens} in, {output_tokens} out, {input_tokens + output_tokens} total, "
          f"est. cost ${cost:.4f}")

    if response_text.startswith("```"):
        response_text = response_text.strip("`")
        if response_text.lower().startswith("json"):
            response_text = response_text[4:]
        response_text = response_text.strip()

    try:
        parsed = json.loads(response_text)
    except json.JSONDecodeError as e:
        stop_reason = response.get("stopReason", "unknown")
        raise RuntimeError(f"Model did not return valid JSON (stopReason={stop_reason}): {e}\n"
                           f"Raw response:\n{response_text}")

    return {"header_fields": tidy_header_fields(parsed.get("header_fields", [])), "cost": cost}


PLACEHOLDER_VALUES = {"_", "-", "--", "na", "n/a", "nil", "none", "null"}


def tidy_header_fields(header_fields: list) -> list:
    """Collapse whitespace, drop blank/placeholder values and number duplicate names
    ("Delivery Address 2") so nothing gets overwritten when keyed by name."""
    for field in header_fields:
        field["value"] = " ".join(str(field.get("value", "")).split())
    blank = [f.get("field", "") for f in header_fields if f["value"].lower() in PLACEHOLDER_VALUES | {""}]
    header_fields = [f for f in header_fields if f["value"].lower() not in PLACEHOLDER_VALUES | {""}]
    if blank:
        print(f"  [Header] dropped {len(blank)} blank field(s): {', '.join(blank)}")

    seen = {}
    for field in header_fields:
        name = str(field.get("field", ""))
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            field["field"] = f"{name} {seen[name]}"
            print(f"  [Header] renamed duplicate '{name}' to '{field['field']}'")
    return header_fields


def extract_header_from_text(bedrock, page_text: str, header_notes: str = None, last_text: str = "") -> dict:
    return call_model_for_header(bedrock, [{"text": build_text_mode_prompt(page_text, header_notes, last_text)}],
                                 "TEXT mode (PDF text layer)")


def extract_header_from_image(bedrock, pdf_bytes: bytes, header_notes: str = None,
                              read_last_page: bool = False) -> dict:
    page_images = render_header_pages_to_png(pdf_bytes, dpi=VISION_IMAGE_DPI, read_last_page=read_last_page)
    content_blocks = [{"image": {"format": "png", "source": {"bytes": img}}} for img in page_images]
    content_blocks.append({"text": VISION_HEADER_PROMPT + channel_notes_block(header_notes)})
    return call_model_for_header(bedrock, content_blocks,
                                 f"VISION mode, {len(page_images)} page image(s) at {VISION_IMAGE_DPI} DPI")


# --- header validation ---

PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# matched against lower-cased field names
IS_PAN = re.compile(r"\bpan\b")                                   # word boundary so "company" doesn't match
IS_GSTIN = re.compile(r"\bgst(in)?\b")
# PO number, or STR/STN/STO number for stock transfers (Myntra)
IS_PO_NUMBER = re.compile(
    r"\b(p\.?\s?o\.?|purchase order|order)\s*(number|no\.?|#|id)?\s*$|"
    r"\b(p\.?\s?o\.?|purchase order)\s*(number|no\.?|#)|"
    r"\b(str|stn|sto|stock transfer(\s+(request|note|order))?)\s*(number|no\.?|#|id)(?!\w)"
)
IS_ID_FIELD = re.compile(r"\b(number|no\.?|code|id|ref(erence)?|#)\s*$")
IS_PHONE = re.compile(r"\b(phone|mobile|tel|contact no\.?)\b")
IS_PINCODE = re.compile(r"\b(pin\s?code|pincode|postal code|zip)\b")
LOOKALIKE_BETWEEN_DIGITS = re.compile(r"(?<=[0-9])[OoIl](?=[0-9])")

# for finding IDs inside free text
GSTIN_IN_TEXT = re.compile(r"(?<![A-Z0-9])[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z](?![A-Z0-9])")
PAN_IN_TEXT = re.compile(r"(?<![A-Z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Z0-9])")
CIN_IN_TEXT = re.compile(r"(?<![A-Z0-9])[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}(?![A-Z0-9])")


def _strip_to_id(value: str, pattern) -> str:
    """Strip a stuck-on label, e.g. 'GST:19AACCI2053A1Z4' becomes '19AACCI2053A1Z4'."""
    found = pattern.search(value)
    return found.group(0) if found and found.group(0) != value else value


def gstin_check_digit_ok(gstin: str) -> bool:
    """15th character is a mod-36 check digit over the first 14."""
    total = 0
    for i, ch in enumerate(gstin[:14]):
        value = GSTIN_CHARSET.index(ch) * (2 if i % 2 else 1)
        total += value // 36 + value % 36
    return GSTIN_CHARSET[(36 - total % 36) % 36] == gstin[14]


def flat(text: str) -> str:
    """Normalise text for substring matching: drop whitespace, commas and dash variants."""
    text = str(text).replace("–", "-").replace("—", "-").replace("⁠", "").replace("​", "")
    return re.sub(r"[\s,;]+", "", text).lower()


def validate_header_fields(header_fields: list, page_text) -> list:
    """Clean up PAN/GSTIN values in place and return a list of warnings.
    page_text is None in VISION mode."""
    warnings = []
    source = flat(page_text) if page_text else None
    pans, gstins, po_numbers = [], [], []

    for field in header_fields:
        name = str(field.get("field", ""))
        lname = name.lower()
        value = str(field.get("value", "")).strip()

        # catches values the model reworded, merged or made up
        if source is not None and value and flat(value) not in source:
            warnings.append(f"'{name}' = '{value}' was not found verbatim in the PDF text, "
                            f"the model may have reworded or merged it.")

        if IS_PAN.search(lname):
            value = _strip_to_id(value.replace(" ", "").upper(), PAN_IN_TEXT)
            field["value"] = value
            pans.append((name, value))
            if not PAN_RE.match(value):
                warnings.append(f"PAN '{name}' = '{value}' doesn't match the AAAAA9999A pattern.")
            continue

        if IS_GSTIN.search(lname):
            value = _strip_to_id(value.replace(" ", "").upper(), GSTIN_IN_TEXT)
            field["value"] = value
            if not GSTIN_RE.match(value):
                warnings.append(f"GSTIN '{name}' = '{value}' doesn't match the 15-character GSTIN format.")
            elif not gstin_check_digit_ok(value):
                warnings.append(f"GSTIN '{name}' = '{value}' fails its check digit, a character is misread.")
            else:
                gstins.append((name, value))
            continue

        if IS_PO_NUMBER.search(lname) and "date" not in lname:
            po_numbers.append((name, value))
            if re.search(r"\s", value):
                warnings.append(f"Document number '{name}' = '{value}' contains spaces. It should be "
                                f"one unbroken string (another field may have been merged into it).")

        if IS_PHONE.search(lname):
            digits = re.sub(r"\D", "", value)
            if re.search(r"[A-Za-z]", value) or not 10 <= len(digits) <= 12:
                warnings.append(f"Phone '{name}' = '{value}' isn't a 10-12 digit phone number.")
            continue

        if IS_PINCODE.search(lname) and not re.fullmatch(r"[1-9][0-9]{5}", value.replace(" ", "")):
            warnings.append(f"Pincode '{name}' = '{value}' isn't a 6-digit pincode.")
            continue

        if (IS_ID_FIELD.search(lname) or IS_PO_NUMBER.search(lname)) and LOOKALIKE_BETWEEN_DIGITS.search(value):
            warnings.append(f"ID '{name}' = '{value}' has a letter O/I/l between digits, "
                            f"probably a misread 0 or 1.")

    if not po_numbers:
        warnings.append("No document number (PO / STR / STN / STO number) was found in the header fields.")

    # GSTIN chars 3-12 are the owner's PAN. A near match with a PAN on the page
    # (1-3 chars off) means one of them was misread.
    for g_name, gstin in gstins:
        embedded = gstin[2:12]
        if any(embedded == pan for _, pan in pans):
            continue
        for p_name, pan in pans:
            if len(pan) == 10:
                diff = sum(a != b for a, b in zip(embedded, pan))
                if 1 <= diff <= 3:
                    warnings.append(f"GSTIN '{g_name}' embeds PAN '{embedded}', but '{p_name}' is "
                                    f"'{pan}' ({diff} character(s) different), one of them is misread.")

    # every GSTIN/PAN/CIN on the page should come back as its own field, not just inside an address
    if page_text:
        extracted = {re.sub(r"\s", "", str(f.get("value", ""))).upper() for f in header_fields}
        for kind, pattern in (("GSTIN", GSTIN_IN_TEXT), ("PAN", PAN_IN_TEXT), ("CIN", CIN_IN_TEXT)):
            for found in sorted(set(pattern.findall(page_text))):
                if found not in extracted:
                    warnings.append(f"{kind} '{found}' is printed on the PO but wasn't extracted as its own field.")

    return warnings


# --- output ---

def _unique(names: list) -> list:
    """Repeated column names get a number ("Qty", "Qty 2") so no value is lost in a dict."""
    seen, out = {}, []
    for name in names:
        seen[name] = seen.get(name, 0) + 1
        out.append(name if seen[name] == 1 else f"{name} {seen[name]}")
    return out


def build_output(header_fields: list, totals: list, line_columns: list, line_rows: list, warnings: list) -> dict:
    """The raw extraction: header and totals keyed by their printed names, one dict per line item."""
    columns = _unique(line_columns)
    return {
        "header": {f.get("field", ""): f.get("value", "") for f in header_fields},
        "totals": {t["field"]: t["value"] for t in totals},
        "line_item_columns": columns,
        "line_items": [dict(zip(columns, row)) for row in line_rows],
        "warnings": warnings,
    }


class PipelineError(RuntimeError):
    """Raised when a run fails (bad file, AWS or model error)."""


def process(pdf_path: str, items_path: str, clients: dict = None, header_notes: str = None,
            pdf_totals: dict = None, read_last_page: bool = False) -> dict:
    """Run one PO (PDF + line-items file) and return the extracted data as a dict.
    Raises PipelineError on failure. Called from run_po.py and main().
    header_notes (layout hints for the header prompt), pdf_totals (see check_pdf_totals) and
    read_last_page (also send the last page, for totals printed at the end) are optional
    channel settings from channels.json."""
    run_started = time.time()
    clients = clients or make_clients()

    # line items first, so a bad file fails before we pay for a model call
    try:
        print(f"Reading line items from: {items_path}")
        fmt, csv_text = convert_to_csv(items_path, read_file_bytes(clients["s3"], items_path))
        print(f"  [Input] format {fmt.upper()}, converted to CSV")
        items = read_line_items_from_csv(csv_text)
        print(f"  [Line items file] {len(items['rows'])} rows, {len(items['columns'])} columns, "
              f"{len(items['totals'])} totals\n")

        print(f"Reading PO from: {pdf_path}")
        pdf_bytes = read_file_bytes(clients["s3"], pdf_path)
        text_ok, reason, page_text = assess_text_layer(pdf_bytes)
        last_text = last_page_text(pdf_bytes) if read_last_page else ""
    except NoCredentialsError as e:
        raise PipelineError("No AWS credentials found. Run `aws configure` first.") from e
    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "Unknown")
        raise PipelineError(f"{error_code} - {e}") from e
    except (OSError, ValueError, RuntimeError) as e:
        raise PipelineError(str(e)) from e

    if HEADER_MODE == "text" or (HEADER_MODE == "auto" and text_ok):
        mode = "TEXT"
    else:
        mode = "VISION"
    print(f"  [Text layer] {'ok' if text_ok else 'not usable'}: {reason}")
    print(f"  [Header mode] {mode}" + (f" (forced by HEADER_MODE='{HEADER_MODE}')" if HEADER_MODE != "auto" else "")
          + ("" if mode == "TEXT" or HEADER_MODE != "auto" else ", using the page image instead") + "\n")

    pages = "page 1" + (" + last page" if read_last_page else "")
    print(f"Calling {BEDROCK_MODEL_ID} for header fields ({pages}, {mode} mode)...")
    try:
        if mode == "TEXT":
            header_result = extract_header_from_text(clients["bedrock"], page_text, header_notes, last_text)
        else:
            header_result = extract_header_from_image(clients["bedrock"], pdf_bytes, header_notes, read_last_page)
    except Exception as e:
        raise PipelineError(f"calling Bedrock (header fields): {e}") from e

    header_fields = header_result["header_fields"]
    line_columns, line_rows, totals = items["columns"], items["rows"], items["totals"]
    header_warnings = validate_header_fields(header_fields, page_text + "\n" + last_text if mode == "TEXT" else None)
    if pdf_totals:
        header_fields, pdf_total_fields, pdf_total_warnings = check_pdf_totals(
            header_fields, line_columns, line_rows, pdf_totals)
        totals = totals + pdf_total_fields
        header_warnings += pdf_total_warnings

    print(f"\nExtracted {len(header_fields)} header field(s) [{mode}], {len(totals)} total(s) "
          f"and {len(line_rows)} line item(s) [{fmt.upper()} file].\n")

    arithmetic_warnings, arithmetic_summary = validate_line_items(line_columns, line_rows)
    print(f"  [Line items] {arithmetic_summary}\n")

    all_warnings = header_warnings + reconcile_totals(line_columns, line_rows, totals) + arithmetic_warnings
    if all_warnings:
        print(f"Validation: {len(all_warnings)} issue(s) to review:")
        for w in all_warnings:
            print(f"  - {w}")
    else:
        print("Validation: no issues.")

    print(f"\nCost:")
    print(f"  {fmt.upper()} file (line items + totals):  $0.0000")
    print(f"  Header ({mode} mode):                ${header_result['cost']:.4f}")
    print(f"  Total:                            ${header_result['cost']:.4f}\n")

    print(f"Took {time.time() - run_started:.1f}s")
    return build_output(header_fields, totals, line_columns, line_rows, all_warnings)


def main():
    if len(sys.argv) != 3:
        print("Usage: python extract_text_first_excel_v2.py <pdf: s3://... or local> "
              "<line-items file (.xlsx/.xls/.csv/.tsv): s3://... or local>")
        sys.exit(1)
    try:
        with contextlib.redirect_stdout(sys.stderr):      # log to stderr, JSON alone on stdout
            result = process(sys.argv[1], sys.argv[2])
    except PipelineError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    sys.stdout.reconfigure(encoding="utf-8")       # Windows defaults to cp1252 when redirected
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
