"""
PO extraction for channels that send only a PDF (no line-items spreadsheet).

Text-first variant of extract_hybrid_parallel.py, using Qwen3 VL on Bedrock.
Line-item tables come from the PDF text layer via PyMuPDF when it's usable, otherwise
from Textract (needs the PDF in S3). Header fields come from the first/last page text,
or from rendered page images if the text layer is bad. All line items go to the model
in a single call, so a PO too big for the 8K output limit fails instead of being cut short.

Usage:
    python extract_hybrid_text_first_v2.py <s3://bucket/key or local path>

Local paths only work in TEXT mode since the Textract fallback needs S3. Prints the
extracted PO as JSON; the log goes to stderr.

Setup: pip install boto3 pymupdf, then aws configure.
"""

import os
import sys
import re
import io
import time
import json
import csv
import contextlib
from concurrent.futures import ThreadPoolExecutor
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, NoCredentialsError

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz         # older PyMuPDF
    except ImportError:
        fitz = None

AWS_REGION = "ap-south-1"           # Textract / S3
POLL_INITIAL_INTERVAL_SECONDS = 1
POLL_MAX_INTERVAL_SECONDS = 5
MAX_WAIT_SECONDS = 900              # big POs can take a while in Textract
TEXTRACT_PAGE_SIZE = 1000           # max blocks per GetDocumentAnalysis call

BEDROCK_REGION = "ap-south-1"
# Qwen3 VL handles text and images, runs in ap-south-1 and isn't a Marketplace model
BEDROCK_MODEL_ID = "qwen.qwen3-vl-235b-a22b"
BEDROCK_MAX_TOKENS = 8000           # model max, anything higher is rejected
TEMPERATURE = 0.0                   # keeps field names stable between runs

# Mumbai on-demand pricing, only used for the cost printout. Check the Bedrock pricing page now and then.
MODEL_INPUT_COST_PER_M = 0.62       # USD per 1M input tokens
MODEL_OUTPUT_COST_PER_M = 3.13      # USD per 1M output tokens
TEXTRACT_TABLES_COST_PER_PAGE = 0.015

# Header is nearly always on page 1; totals sometimes repeat on the last page.
def get_header_page_indices(num_pages: int) -> list:
    if num_pages <= 1:
        return [0]
    return [0, num_pages - 1]

VISION_IMAGE_DPI = 300              # only for the VISION header fallback

# "auto" uses TEXT when the text layer looks fine. Set one explicitly to compare modes.
HEADER_MODE = "auto"                # "auto" | "text" | "vision"
LINE_ITEMS_MODE = "auto"            # "auto" | "text" | "textract"

# --- text layer checks ---
MIN_TEXT_CHARS = 100                # page 1 non-space chars
MIN_PAGE_TEXT_CHARS = 20            # other pages, less than this is probably a scan
MIN_ALNUM_RATIO = 0.5               # below this the text is garbled
MAX_INVISIBLE_RATIO = 0.5           # invisible text (render mode 3) means an OCR layer over a scan
MAX_IMAGE_COVERAGE = 0.9            # one image this big means a scanned page
MIN_PO_KEYWORDS = 2                 # PO-ish words needed on page 1
PO_KEYWORDS = ("po", "order", "purchase", "gst", "gstin", "vendor", "supplier", "date",
               "deliver", "delivery", "ship", "bill", "pan", "qty", "quantity", "total",
               "str", "stn", "transfer")
MIN_TABLE_ROWS_FROM_TEXT = 2        # fewer rows than this and we go to Textract
# page with the PO totals, also sent with the header in TEXT mode
TOTALS_PAGE_RE = re.compile(r"\b(grand total|total amount|net amount|amount in words|total)\b", re.IGNORECASE)


def parse_s3_uri(s3_uri: str) -> tuple:
    if not s3_uri.startswith("s3://"):
        raise ValueError("S3 path must start with s3://, e.g. s3://my-bucket/my-file.pdf")
    without_prefix = s3_uri[len("s3://"):]
    bucket, _, key = without_prefix.partition("/")
    if not bucket or not key:
        raise ValueError("Could not parse bucket/key from S3 path.")
    return bucket, key


def make_clients() -> dict:
    """
    Shared boto3 clients. Created up front because creating clients from several threads
    isn't safe. Adaptive retries let the parallel Bedrock calls ride out throttling.
    """
    config = Config(
        retries={"max_attempts": 10, "mode": "adaptive"},
        read_timeout=300,
        max_pool_connections=8,
    )
    return {
        "textract": boto3.client("textract", region_name=AWS_REGION, config=config),
        "s3": boto3.client("s3", region_name=AWS_REGION, config=config),
        "bedrock": boto3.client("bedrock-runtime", region_name=BEDROCK_REGION, config=config),
    }


def read_pdf_bytes(s3, path: str) -> bytes:
    if path.startswith("s3://"):
        bucket, key = parse_s3_uri(path)
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    with open(path, "rb") as f:
        return f.read()


# --- text layer check ---

def assess_page(page, min_chars: int, require_keywords: bool) -> tuple:
    """(usable, reason): is this page real digital text rather than a scan or garbage?"""
    text = page.get_text()
    non_space = [c for c in text if not c.isspace()]
    if len(non_space) < min_chars:
        return False, f"only {len(non_space)} characters of text, probably a scanned page"

    garbled = text.count("�") + len(re.findall(r"\(cid:\d+\)", text))
    alnum_ratio = sum(c.isalnum() for c in non_space) / len(non_space)
    if garbled or alnum_ratio < MIN_ALNUM_RATIO:
        return False, (f"text looks garbled ({garbled} unreadable glyph(s), "
                       f"{alnum_ratio:.0%} letters/digits), broken font encoding")

    # scanner OCR text is invisible (render mode 3) and has OCR mistakes, so don't trust it
    char_types = [span["type"] for span in page.get_texttrace() for _ in span["chars"]]
    if char_types:
        invisible_ratio = char_types.count(3) / len(char_types)
        if invisible_ratio > MAX_INVISIBLE_RATIO:
            return False, f"{invisible_ratio:.0%} of the text is invisible, looks like OCR over a scan"

    page_area = page.rect.width * page.rect.height
    for info in page.get_image_info():
        x0, y0, x1, y1 = info["bbox"]
        coverage = (x1 - x0) * (y1 - y0) / page_area if page_area else 0
        if coverage >= MAX_IMAGE_COVERAGE:
            return False, f"one image covers {coverage:.0%} of the page, looks scanned"

    if require_keywords:
        words = set(re.findall(r"[a-z]+", text.lower()))
        found = [k for k in PO_KEYWORDS if k in words]
        if len(found) < MIN_PO_KEYWORDS:
            return False, f"text doesn't look like a PO (keywords found: {found or 'none'})"
        return True, (f"{len(non_space)} characters of digital text, {alnum_ratio:.0%} letters/digits, "
                      f"PO keywords: {', '.join(found[:6])}")
    return True, f"{len(non_space)} characters of digital text"


INDENT_POINTS = 6.0                 # one leading space per this many points from the left margin


def layout_text(page, y_tolerance: float = 3.0, column_gap: float = 18.0) -> str:
    """
    Rebuild the page as visual lines (words on the same baseline, left to right, wide gaps
    as " | "), so labels sit next to their values even on SAP-style forms. Lines are
    indented by their x position so a stray line still shows which box it belongs to.
    """
    words = sorted(page.get_text("words"), key=lambda w: (round(w[3], 1), w[0]))
    margin = min((w[0] for w in words), default=0)
    lines = []
    for w in words:
        if lines and abs(lines[-1]["y"] - w[3]) <= y_tolerance:
            lines[-1]["words"].append(w)
        else:
            lines.append({"y": w[3], "words": [w]})
    out = []
    for line in lines:
        line_words = sorted(line["words"], key=lambda w: w[0])
        parts, prev_x1 = [" " * int((line_words[0][0] - margin) / INDENT_POINTS)], None
        for w in line_words:
            if prev_x1 is not None:
                parts.append(" | " if w[0] - prev_x1 > column_gap else " ")
            parts.append(w[4])
            prev_x1 = w[2]
        out.append("".join(parts))
    return "\n".join(out)


def inspect_text_layer(pdf_bytes: bytes) -> dict:
    """Check each page's text layer and collect the text needed for TEXT mode."""
    if fitz is None:
        raise RuntimeError("pymupdf is required to read the PDF. Run: pip install pymupdf")

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        num_pages = doc.page_count
        pages = []
        for i, page in enumerate(doc):
            ok, reason = assess_page(page, MIN_TEXT_CHARS if i == 0 else MIN_PAGE_TEXT_CHARS,
                                     require_keywords=(i == 0))
            pages.append({"ok": ok, "reason": reason, "text": page.get_text(), "layout": ""})

        # also add the last page with totals on it, in case the final page is just T&Cs
        header_pages = get_header_page_indices(num_pages)
        totals_pages = [i for i, p in enumerate(pages) if TOTALS_PAGE_RE.search(p["text"])]
        if totals_pages and totals_pages[-1] not in header_pages:
            header_pages = sorted(header_pages + [totals_pages[-1]])
        for i in header_pages:
            pages[i]["layout"] = layout_text(doc[i])
    finally:
        doc.close()

    bad = [f"page {i + 1}: {p['reason']}" for i, p in enumerate(pages) if not p["ok"]]
    header_bad = [f"page {i + 1}: {pages[i]['reason']}" for i in header_pages if not pages[i]["ok"]]
    return {
        "num_pages": num_pages,
        "pages": pages,
        "header_pages": header_pages,
        "header_ok": not header_bad,
        "header_reason": "; ".join(header_bad) if header_bad else pages[0]["reason"],
        "all_pages_ok": not bad,
        "all_pages_reason": "; ".join(bad) if bad else f"all {num_pages} page(s) have digital text",
    }


# --- tables from the text layer ---

def join_cell_lines(cell_text) -> str:
    """Join a wrapped cell's lines with spaces, but glue digit-to-digit wraps back into one number."""
    lines = [ln.strip() for ln in str(cell_text or "").split("\n") if ln.strip()]
    if not lines:
        return ""
    result = lines[0]
    for nxt in lines[1:]:
        if result[-1].isdigit() and nxt[0].isdigit():
            result += nxt
        else:
            result += " " + nxt
    return result.strip()


def extract_tables_from_text_layer(pdf_bytes: bytes) -> list:
    """
    All ruled tables PyMuPDF finds, in the same shape as extract_tables().
    row_confidences are None since there's no OCR involved.
    """
    tables = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        for page_no, page in enumerate(doc, start=1):
            with contextlib.redirect_stdout(io.StringIO()):   # PyMuPDF prints a tip here
                found = page.find_tables()
            for table in found.tables:
                grid = [[join_cell_lines(c) for c in row] for row in table.extract()]
                grid = [row for row in grid if any(cell for cell in row)]
                if not grid:
                    continue
                width = max(len(r) for r in grid)
                grid = [r + [""] * (width - len(r)) for r in grid]
                tables.append({"page": page_no, "columns": width, "grid": grid,
                               "row_confidences": [None] * len(grid)})
    finally:
        doc.close()
    return tables


# --- Textract fallback ---

def start_document_analysis(textract, bucket: str, key: str) -> str:
    response = textract.start_document_analysis(
        DocumentLocation={"S3Object": {"Bucket": bucket, "Name": key}},
        FeatureTypes=["TABLES"],
    )
    return response["JobId"]


def wait_for_job(textract, job_id: str) -> dict:
    """Poll until the job is done. The final response already has the first page of blocks."""
    interval = POLL_INITIAL_INTERVAL_SECONDS
    started = time.time()
    attempt = 0
    while True:
        attempt += 1
        response = textract.get_document_analysis(JobId=job_id, MaxResults=TEXTRACT_PAGE_SIZE)
        status = response["JobStatus"]
        elapsed = time.time() - started
        print(f"  [Textract] {status} (check {attempt}, {elapsed:.0f}s)")
        if status == "SUCCEEDED":
            return response
        if status in ("FAILED", "PARTIAL_SUCCESS"):
            raise RuntimeError(f"Textract job {status}: {response.get('StatusMessage', 'no message')}")
        if elapsed >= MAX_WAIT_SECONDS:
            raise TimeoutError(f"Textract job did not complete within {MAX_WAIT_SECONDS}s.")
        time.sleep(interval)
        interval = min(interval * 1.5, POLL_MAX_INTERVAL_SECONDS)


def get_full_blocks(textract, job_id: str, first_response: dict) -> list:
    all_blocks = list(first_response.get("Blocks", []))
    next_token = first_response.get("NextToken")
    while next_token:
        response = textract.get_document_analysis(
            JobId=job_id, MaxResults=TEXTRACT_PAGE_SIZE, NextToken=next_token
        )
        all_blocks.extend(response.get("Blocks", []))
        next_token = response.get("NextToken")
    return all_blocks


def build_block_map(blocks: list) -> dict:
    return {block["Id"]: block for block in blocks}


# words within this Top distance (page-normalized) count as the same line inside a cell
CELL_LINE_CLUSTER_TOLERANCE = 0.008


def get_cell_text_and_confidence(cell_block: dict, block_map: dict) -> tuple:
    """
    Cell text rebuilt from word positions (so numbers wrapped in narrow columns are
    rejoined), plus the average Textract confidence of its words.
    """
    words = []
    for relationship in cell_block.get("Relationships", []):
        if relationship["Type"] != "CHILD":
            continue
        for child_id in relationship["Ids"]:
            child = block_map.get(child_id, {})
            if child.get("BlockType") == "WORD":
                words.append(child)
            elif child.get("BlockType") == "SELECTION_ELEMENT" and child.get("SelectionStatus") == "SELECTED":
                words.append({"Text": "[X]", "Geometry": child.get("Geometry", {}), "Confidence": 99.0})

    if not words:
        return "", None

    def word_position(w):
        bbox = w.get("Geometry", {}).get("BoundingBox", {})
        return bbox.get("Top", 0.0), bbox.get("Left", 0.0)

    words.sort(key=word_position)

    lines = []
    for w in words:
        top, _ = word_position(w)
        placed = False
        for line in lines:
            if abs(line["top"] - top) <= CELL_LINE_CLUSTER_TOLERANCE:
                line["words"].append(w)
                placed = True
                break
        if not placed:
            lines.append({"top": top, "words": [w]})
    lines.sort(key=lambda l: l["top"])

    line_texts = []
    for line in lines:
        line_words = sorted(line["words"], key=lambda w: word_position(w)[1])
        line_texts.append(" ".join(w.get("Text", "") for w in line_words))

    result = line_texts[0]
    for next_line_text in line_texts[1:]:
        prev_char = result[-1] if result else ""
        next_char = next_line_text[0] if next_line_text else ""
        if prev_char.isdigit() and next_char.isdigit():
            result += next_line_text
        else:
            result += " " + next_line_text

    confidences = [w.get("Confidence", 0.0) for w in words if w.get("Confidence") is not None]
    avg_confidence = sum(confidences) / len(confidences) if confidences else None

    return result.strip(), avg_confidence


def extract_tables(blocks: list, block_map: dict) -> list:
    """Textract TABLE blocks as grids, with the average OCR confidence of each row."""
    tables = []

    for block in blocks:
        if block.get("BlockType") != "TABLE":
            continue

        cells_by_row = {}
        conf_by_row = {}
        for relationship in block.get("Relationships", []):
            if relationship["Type"] != "CHILD":
                continue
            for cell_id in relationship["Ids"]:
                cell = block_map.get(cell_id, {})
                if cell.get("BlockType") != "CELL":
                    continue
                row_index = cell.get("RowIndex", 0)
                col_index = cell.get("ColumnIndex", 0)
                cell_text, cell_conf = get_cell_text_and_confidence(cell, block_map)
                cells_by_row.setdefault(row_index, {})[col_index] = cell_text
                if cell_conf is not None:
                    conf_by_row.setdefault(row_index, []).append(cell_conf)

        if not cells_by_row:
            continue

        grid = []
        row_confidences = []
        for row_index in sorted(cells_by_row.keys()):
            row_cells = cells_by_row[row_index]
            max_col = max(row_cells.keys())
            row = [row_cells.get(col, "") for col in range(1, max_col + 1)]
            grid.append(row)

            confs = conf_by_row.get(row_index, [])
            row_confidences.append(sum(confs) / len(confs) if confs else None)

        tables.append({
            "page": block.get("Page", 1),
            "columns": len(grid[0]) if grid else 0,
            "grid": grid,
            "row_confidences": row_confidences,
        })

    return tables


def all_tables_to_text(tables: list) -> str:
    if not tables:
        return "(No tables detected on this document.)"
    blocks_text = []
    for i, table in enumerate(tables, start=1):
        rows = len(table["grid"])
        cols = table["columns"]
        header = f"[TABLE {i} — page {table['page']}, {rows} row(s) x {cols} column(s)]"
        grid_text = "\n".join(" | ".join(cell for cell in row) for row in table["grid"])
        blocks_text.append(f"{header}\n{grid_text}")
    return "\n\n".join(blocks_text)


def _is_main_header(row: list) -> bool:
    """Header row: at least half the columns (min 3) filled, and no numbers."""
    filled = [c for c in row if c.strip()]
    return len(filled) >= max(3, len(row) / 2) and not any(_is_number(c) for c in filled)


def _is_total_row(row: list) -> bool:
    filled = [c for c in row if c.strip()]
    return bool(filled) and bool(re.match(r"^(grand\s+)?total\b", filled[0].strip(), re.IGNORECASE))


def _unstack_table(table: dict):
    """
    Flatten a table where every line item takes two grid rows into one row per item.
    A column with values in both rows is split into two columns; otherwise its two header
    lines are joined. Returns [rows above the header, item table], or None if the table
    isn't laid out like this.
    """
    grid, width = table["grid"], table["columns"]
    h = next((i for i, row in enumerate(grid) if _is_main_header(row)), None)
    if h is None:
        return None
    sub = grid[h + 1] if h + 1 < len(grid) else None
    if sub is None or _serial_no(sub) or not any(c.strip() for c in sub) \
            or any(_is_number(c) for c in sub if c.strip()):
        sub = None
    bottom = sub or [""] * width
    confs = table.get("row_confidences") or [None] * len(grid)

    pairs, others = [], []           # pairs: (top row, bottom row, confidence); others: rows after the items
    i = h + (2 if sub else 1)
    while i < len(grid):
        row = grid[i]
        if _serial_no(row):
            nxt = grid[i + 1] if i + 1 < len(grid) else None
            if others or nxt is None or _serial_no(nxt) or _is_total_row(nxt) \
                    or sum(1 for c in nxt if c.strip()) < 2:
                return None          # single-row item or something in between, not this layout
            known = [c for c in (confs[i], confs[i + 1]) if c is not None]
            pairs.append((row, nxt, min(known) if known else None))
            i += 2
        elif pairs:
            others.append((row, confs[i]))
            i += 1
        else:
            return None              # junk between the header and the first item
    if len(pairs) < 2:
        return None

    def has_data(c, which):
        return any(p[which][c].strip() for p in pairs)

    # A merged header cell over several columns is split word by word if each word matches
    # the start of the sub-header under it, otherwise the whole name applies to every column.
    top = grid[h]
    top_names = {}
    starts = [j for j in range(width) if top[j].strip()]
    for s, start in enumerate(starts):
        end = starts[s + 1] if s + 1 < len(starts) else width
        span_name = top[start].strip()
        used = [c for c in range(start, end) if bottom[c].strip() or has_data(c, 0) or has_data(c, 1)]
        tokens = span_name.split()
        split = len(used) > 1 and len(tokens) == len(used) and all(
            re.sub(r"[^a-z]", "", t.lower()) and
            re.sub(r"[^a-z]", "", bottom[c].lower()).startswith(re.sub(r"[^a-z]", "", t.lower()))
            for t, c in zip(tokens, used))
        for n, c in enumerate(used):
            top_names[c] = tokens[n] if split else span_name
        if start not in used:
            top_names[start] = span_name          # named column that's empty on this PO
    for c in range(width):
        if c not in top_names and bottom[c].strip():
            top_names[c] = ""                     # only has a sub-header

    columns, sources, position = [], [], {}       # sources: (grid column, 0 top row / 1 bottom row)
    for c in sorted(top_names):
        t, b = top_names[c], bottom[c].strip()
        position[c] = len(columns)
        if has_data(c, 0) and has_data(c, 1):     # two fields stacked in one column
            if b:
                names = [t or b, b if t else f"{b} (2nd line)"]
            elif "/" in t:
                first, second = t.split("/", 1)
                names = [first.strip(), second.strip()]
            else:
                names = [t, f"{t} (2nd line)"]
            columns += names
            sources += [(c, 0), (c, 1)]
        else:
            columns.append(" ".join(x for x in (t, b) if x))
            sources.append((c, 1 if has_data(c, 1) else 0))
    seen = {}
    for n, name in enumerate(columns):
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            columns[n] = f"{name} {seen[name]}"

    items = [[pair[w][c] for c, w in sources] for pair in pairs]
    tail = []                                     # Total row etc., values mapped to the new columns
    for row, _ in others:
        out = [""] * len(columns)
        for c, value in enumerate(row):
            if not value.strip():
                continue
            k = max((p for p in position if p <= c), default=min(position))
            out[position[k]] = f"{out[position[k]]} {value}".strip()
        tail.append(out)

    result = []
    if h:
        result.append({"page": table["page"], "columns": width, "grid": grid[:h],
                       "row_confidences": confs[:h]})
    result.append({"page": table["page"], "columns": len(columns), "grid": [columns] + items + tail,
                   "row_confidences": [None] + [p[2] for p in pairs] + [c for _, c in others]})
    return result


def unstack_two_row_items(tables: list) -> tuple:
    """Run _unstack_table over every table. Returns (tables, notes)."""
    out, notes = [], []
    for table in tables:
        new = _unstack_table(table)
        if new is None:
            out.append(table)
            continue
        items = new[-1]
        notes.append(f"page {table['page']}: two-row line items merged into "
                     f"{len(items['grid']) - 1 - sum(_is_total_row(r) for r in items['grid'])} "
                     f"one-row item(s), {items['columns']} columns")
        out += new
    return out, notes


def run_textract_stage(textract, bucket: str, key: str) -> dict:
    print("  [Textract] starting AnalyzeDocument job (TABLES)")
    job_id = start_document_analysis(textract, bucket, key)
    print(f"  [Textract] JobId: {job_id}")
    final_response = wait_for_job(textract, job_id)

    blocks = get_full_blocks(textract, job_id, final_response)
    block_map = build_block_map(blocks)
    num_pages = max((b.get("Page", 1) for b in blocks), default=1)
    all_tables = extract_tables(blocks, block_map)

    return {"num_pages": num_pages, "all_tables": all_tables}


def run_tables_stage(textract, pdf_path: str, pdf_bytes: bytes, text_info: dict) -> dict:
    """Tables from the text layer if possible, otherwise Textract."""
    if LINE_ITEMS_MODE == "textract":
        reason = "forced by LINE_ITEMS_MODE='textract'"
    else:
        reason = text_info["all_pages_reason"]
    if LINE_ITEMS_MODE == "text" or (LINE_ITEMS_MODE == "auto" and text_info["all_pages_ok"]):
        tables = extract_tables_from_text_layer(pdf_bytes)
        found_rows = sum(len(t["grid"]) for t in tables)
        if LINE_ITEMS_MODE == "text" or found_rows >= MIN_TABLE_ROWS_FROM_TEXT:
            print(f"  [Tables | TEXT] {len(tables)} table(s), {found_rows} row(s) from the "
                  f"text layer")
            return {"source": "TEXT", "num_pages": text_info["num_pages"], "all_tables": tables}
        reason = f"only {found_rows} table row(s) found in the text layer"

    print(f"  [Tables | TEXTRACT] using Textract: {reason}")
    if not pdf_path.startswith("s3://"):
        raise RuntimeError("Textract needs the PDF in S3, re-run with an s3://bucket/key path.")
    bucket, key = parse_s3_uri(pdf_path)
    result = run_textract_stage(textract, bucket, key)
    result["source"] = "TEXTRACT"
    return result


# --- line items (model) ---

TABLE_SOURCE_NAMES = {
    "TEXT": "the PDF's embedded text layer (exact characters, read by a PDF table finder)",
    "TEXTRACT": "AWS Textract (OCR)",
}

LINE_ITEMS_PROMPT_TEMPLATE = """You are extracting the LINE-ITEMS table from a Purchase Order / \
Stock Transfer document. Below is EVERY table detected in the document by {source_name}, each as \
a separate grid, labeled with its page and dimensions.

IMPORTANT — the table detector picks up ANY bordered/gridded section as a "table", not just \
product line items (it also detects Vendor Details boxes, address boxes, etc). Identify which \
detected table(s) are genuinely the line-items table (many rows, one per product — item \
code/description, quantity, price, amount, tax breakdown, HSN/SKU/EAN codes) and IGNORE \
any small header/address grid — do not return those as line items.

If the real line-items table is split across multiple pages (two labeled tables share the \
same columns, and the second one's first row repeats the first one's header row), merge \
them into ONE combined table yourself — keep the header row once, then every data row from \
both, in order. Don't drop or duplicate rows. A row at the top of a continuation page that \
has only an item description (no serial number, code or amounts) is the rest of the LAST \
item's description from the previous page — append it to that item, don't make it a row.

Return ONLY valid JSON (no markdown fences, no commentary) with this exact shape:

{{
  "line_items": {{
    "columns": ["<clean column name>", ...],
    "rows": [["<clean cell value>", ...], ...]
  }}
}}

Rules:
- "columns": clean up the header row — join words split by a stray space/line-wrap \
(e.g. "HSN Cod e" -> "HSN Code", "CG ST %" -> "CGST %"). When a header spans two rows \
(e.g. "IGST" over "%" and "Value"), combine them ("IGST %", "IGST Value"). Keep the same \
number and meaning of columns that were detected; do not invent or drop real columns. \
A header row that is already clean (one name per column) is copied exactly as given.
- "rows": one row per actual line item ONLY. Rejoin any number/code still split by a \
stray space (e.g. "277.7 7" -> "277.77"). Otherwise copy every cell value exactly as given — \
do not reformat numbers, remove thousands separators or retype codes. Do NOT include a \
totals/summary/footer row — that is handled separately, and must not appear in "rows" at all.
- Preserve row order and every genuine line item — do not drop or merge rows together.
- If NO table qualifies as genuine line items, return "columns": [] and "rows": [].

--- EVERY TABLE DETECTED ---
{tables_text}
"""

def call_model_json(bedrock, content_blocks: list, label: str) -> dict:
    """
    One Bedrock converse call, returning the parsed JSON plus tokens and cost.
    Raises RuntimeError on invalid JSON (e.g. cut off at the token limit) so we never
    save a partial result.
    """
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
    print(f"  [{label}] tokens {input_tokens} in / {output_tokens} out "
          f"({input_tokens + output_tokens} total), approx ${cost:.4f}")

    if response_text.startswith("```"):
        response_text = response_text.strip("`")
        if response_text.lower().startswith("json"):
            response_text = response_text[4:]
        response_text = response_text.strip()

    try:
        parsed = json.loads(response_text)
    except json.JSONDecodeError as e:
        stop_reason = response.get("stopReason", "unknown")
        hint = (f": hit the {BEDROCK_MAX_TOKENS}-token output limit, too many line items for "
                f"one call" if stop_reason == "max_tokens" else "")
        raise RuntimeError(f"[{label}] model did not return valid JSON (stopReason={stop_reason}){hint}: {e}\n"
                           f"Raw response:\n{response_text}")

    return {
        "parsed": parsed,
        "cost": cost,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }


def call_model_for_line_items(bedrock, tables_text: str, source: str, label: str = "Line items") -> dict:
    prompt = LINE_ITEMS_PROMPT_TEMPLATE.format(source_name=TABLE_SOURCE_NAMES[source], tables_text=tables_text)
    result = call_model_json(bedrock, [{"text": prompt}], label)
    parsed = result["parsed"]
    return {
        "columns": parsed.get("line_items", {}).get("columns", []),
        "rows": parsed.get("line_items", {}).get("rows", []),
        "cost": result["cost"],
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
    }


def run_line_items_stage(bedrock, all_tables: list, source: str) -> dict:
    """Send all detected tables to the model in one call."""
    tables_text = all_tables_to_text(all_tables)
    print(f"Calling {BEDROCK_MODEL_ID} for line items ({source} tables, "
          f"{len(tables_text)} chars)")
    return call_model_for_line_items(bedrock, tables_text, source, label=f"Line items | {source} tables")


def align_row_confidences(original_tables: list, final_columns: list, final_rows: list) -> list:
    """
    Rough mapping of the model's rows back to Textract row confidences, using the
    biggest table and aligning from the bottom. Gives None when the counts don't fit
    rather than guessing.
    """
    if not original_tables:
        return [None] * len(final_rows)

    candidate = max(original_tables, key=lambda t: len(t["grid"]))    # line items is usually the biggest table
    original_confidences = candidate.get("row_confidences", [])

    # align from the end, the header rows at the top are what usually get dropped
    if len(original_confidences) >= len(final_rows):
        offset = len(original_confidences) - len(final_rows)
        return original_confidences[offset:]

    return [None] * len(final_rows)


# Column names (lower-case, single spaces) used by the row arithmetic check, in priority
# order. Billed qty comes before total qty since total can include free units.
QTY_COLUMNS = ("qty", "qty.", "quantity", "billed qty", "billed quantity", "order qty", "ordered qty",
               "po qty", "invoice qty", "total qty")
RATE_COLUMNS = ("supplier price", "rate/unit", "rate", "unit rate", "unit price", "landing rate",
                "landing cost", "landed price", "landed cost", "basic price", "basic cost price", "basic cost",
                "base cost", "cost price", "list price", "price")
AMOUNT_COLUMNS = ("amount (inr)", "total amount", "total value", "amount", "total amt", "total amt.",
                  "net amount", "line total", "total", "total base value")
TAXABLE_COLUMNS = ("taxable value", "taxable amount", "taxable amt")
# Tax amount columns like "IGST Value", "CGST V", "Tax Amt" or just "IGST".
# A combined "GST Amount" is left out on purpose, it would count the tax twice.
TAX_VALUE_COLUMN_RE = re.compile(r"^(igst|cgst|sgst|ugst|utgst|cess)\b.*\b(value|amt\.?|amount|v)$"
                                 r"|^tax (amt\.?|amount)$|^(igst|cgst|sgst|utgst)$")
TAX_PERCENT_COLUMN_RE = re.compile(r"^(igst|cgst|sgst|utgst|cess)\b.*(%|rate)$")
ROUNDING_TOLERANCE = 1.0            # rupees per row, some POs round to whole rupees
MAX_FAILING_SHARE = 0.5             # if more rows fail than this, the formula just doesn't fit the layout
CURRENCY_TOKENS = re.compile(r"\bINR\b|₹|\bRs\.?", re.IGNORECASE)


def _norm_col(name: str) -> str:
    return re.sub(r"\s+", " ", str(name).strip().lower())


def _to_num(value):
    """Parse '7611.84 INR', '1,234' or '18.00%' as a float, None if it isn't a number."""
    text = CURRENCY_TOKENS.sub("", str(value)).replace(",", "").replace("%", "").strip()
    try:
        return float(text)
    except (ValueError, TypeError):
        return None


def validate_line_items(columns: list, rows: list) -> tuple:
    """
    Per-row arithmetic, as two separate checks:
      Qty x Rate: amount = qty*rate, qty*rate + tax values, or qty*rate*(1 + tax%/100)
      Taxable + tax: amount = taxable + tax values, or taxable*(1 + tax%/100)
    Tolerance is ROUNDING_TOLERANCE or 0.1% of the amount. If most rows fail a check it's
    reported as not applicable instead of warning on every row. Returns (warnings, summary).
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
        return _to_num(row[i]) if i is not None and i < len(row) else None

    def fits(amounts, candidates):
        return any(abs(a - c) <= max(ROUNDING_TOLERANCE, abs(a) * 0.001) for a in amounts for c in candidates)

    def decimal_hint(amounts, candidates):
        # about 10x or 100x off usually means a misplaced decimal point
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
                         f"amounts are computed differently on this layout)")
        else:
            warnings += c["failures"]
            notes.append(f"{label}: {c['checked'] - len(c['failures'])} of {c['checked']} rows OK")
    if not notes:
        return [], "row arithmetic check: skipped (no numeric rows)"
    return warnings, "row arithmetic check: " + "; ".join(notes)


def reconcile_table_totals(columns: list, rows: list, table_totals: list) -> tuple:
    """
    Compare the table's Total row with the column sums. Quantities must match exactly;
    money columns get some slack when rows are rounded to whole rupees.
    Returns (warnings, summary).
    """
    names = [_norm_col(c) for c in columns]
    warnings, checked = [], []
    for total in table_totals:
        target = _norm_col(re.sub(r"^total\s+", "", total["field"], flags=re.IGNORECASE))
        expected = _to_num(total["value"])
        idx = next((i for i, n in enumerate(names) if n == _norm_col(total["field"])), None)  # "Total Value"
        if idx is None:
            idx = next((i for i, n in enumerate(names) if n == target), None)
        if idx is None:     # e.g. "Total IGST" should match the "IGST Value" column
            idx = next((i for i, n in enumerate(names)
                        if n.startswith(target) and re.search(r"\b(value|amt\.?|amount)$", n)), None)
        if idx is None or expected is None:
            continue
        values = [_to_num(r[idx]) for r in rows if idx < len(r)]
        values = [v for v in values if v is not None]
        actual = sum(values)
        if names[idx] in QTY_COLUMNS:
            tolerance = 0.001
        elif all(v == int(v) for v in values):
            tolerance = max(ROUNDING_TOLERANCE, 0.5 * ROUNDING_TOLERANCE * len(values))
        else:
            tolerance = max(0.05, 0.01 * len(values))
        checked.append(columns[idx])
        if abs(actual - expected) > tolerance:
            warnings.append(f"Table '{total['field']}' = {total['value']}, but the '{columns[idx]}' column "
                            f"adds up to {actual:,.2f}")
    if not checked:
        return [], "totals check: skipped (no Total row matched a line-item column)"
    return warnings, f"totals check: {', '.join(checked)} vs the table's Total row"


def _is_number(value: str) -> bool:
    try:
        float(str(value).replace(",", "").strip())
        return True
    except ValueError:
        return False


def _serial_no(row: list):
    """Serial number in the first cell (up to 4 digits), or None."""
    first = row[0].strip() if row else ""
    return first if first.isdigit() and len(first) <= 4 else None


def attach_continuation_descriptions(tables: list, rows: list) -> tuple:
    """
    A description that runs over a page break shows up as a description-only row at the
    top of the next page. Append it to the last item of the previous page.
    Returns (rows, notes).
    """
    item_tables = [t for t in tables if any(_serial_no(r) for r in t["grid"])]
    notes = []
    for prev, table in zip(item_tables, item_tables[1:]):
        last_item = [r for r in prev["grid"] if _serial_no(r)][-1]
        for row in table["grid"]:
            if _serial_no(row):
                break                                   # only look above the page's first item
            filled = [(j, c) for j, c in enumerate(row) if c.strip()]
            if len(filled) != 1 or filled[0][0] == 0 or _is_number(filled[0][1]):
                continue                                # e.g. a repeated header row
            j, text = filled[0]
            prev_desc = last_item[j].strip() if j < len(last_item) else ""
            for out_row in rows:
                if not out_row or str(out_row[0]).strip() != _serial_no(last_item):
                    continue
                for d, value in enumerate(out_row):
                    value = str(value)
                    if prev_desc and value.startswith(prev_desc) and text not in value:
                        out_row[d] = f"{value} {text}"
                        notes.append(f"item {_serial_no(last_item)}: appended '{text}' "
                                     f"(description continued on page {table['page']})")
                        break
                break
    return rows, notes


def find_table_totals(tables: list, unlabeled_total_row: bool = False) -> list:
    """
    Values from the table's own Total row, each named after the header above it
    (e.g. "Total Qty", "Total IGST"). With unlabeled_total_row (a channel setting), a row
    of numbers only, right after the numbered items, also counts as the Total row
    (Unicommerce POs print their totals with no "Total" label).
    """
    totals = []
    for table in tables:
        header = None
        after_items = False                 # an item row was seen since the header
        for row in table["grid"]:
            filled = [c for c in row if c.strip()]
            first = filled[0].strip() if filled else ""
            labeled = bool(re.match(r"^(grand\s+)?total\b", first, re.IGNORECASE))
            unlabeled = (unlabeled_total_row and after_items and not _serial_no(row)
                         and len(filled) >= 2 and all(_is_number(c) for c in filled))
            if header is not None and _serial_no(row):
                after_items = True
            if labeled or unlabeled:
                if header is None:
                    continue
                after_items = False
                label_col = next(i for i, c in enumerate(row) if c.strip()) if labeled else None
                for j, cell in enumerate(row):
                    if j == label_col or not cell.strip() or not _is_number(cell):
                        continue
                    k = min(j, len(header) - 1)
                    while k >= 0 and not header[k].strip():
                        k -= 1                          # merged header, use the name to the left
                    name = header[k].strip() if k >= 0 else f"Column {j + 1}"
                    field = name if re.match(r"total\b", name, re.IGNORECASE) else f"Total {name}"
                    totals.append({"field": field, "value": cell.strip(),
                                   "confidence": "exact (line-items table Total row"
                                                 + (")" if labeled else ", unlabeled)")})
            elif len(filled) >= max(3, len(row) / 2) and not any(_is_number(c) for c in filled):
                # main header row; sub-headers like "% | Value" are too sparse to match
                header = row
    return totals


VALUE_RATE_CELL_RE = re.compile(r"^\s*(-?[\d,]+(?:\.\d+)?)\s*\(\s*(\d+(?:\.\d+)?\s*%)\s*\)\s*$")


def split_value_rate_cells(columns: list, rows: list) -> tuple:
    """
    A column whose cells all hold an amount with its rate, like "545.51 (9.000%)", becomes
    two columns: "SGST" = "545.51" and "SGST Rate" = "9.000%". Used when the channel sets
    split_value_rate_cells. Returns (columns, rows, notes).
    """
    split = []
    for i in range(len(columns)):
        cells = [str(r[i]).strip() for r in rows if i < len(r) and str(r[i]).strip()]
        if cells and all(VALUE_RATE_CELL_RE.match(c) for c in cells):
            split.append(i)
    if not split:
        return columns, rows, []
    new_columns, new_rows = [], [[] for _ in rows]
    for i, name in enumerate(columns):
        new_columns.append(name)
        if i in split:
            new_columns.append(f"{name} Rate")
        for out, row in zip(new_rows, rows):
            value = str(row[i]).strip() if i < len(row) else ""
            if i in split:
                match = VALUE_RATE_CELL_RE.match(value)
                out += [match.group(1), match.group(2).replace(" ", "")] if match else ["", ""]
            else:
                out.append(row[i] if i < len(row) else "")
    notes = [f"split amount and rate: {', '.join(columns[i] for i in split)}"]
    return new_columns, new_rows, notes


def merge_table_totals(header_fields: list, table_totals: list) -> tuple:
    """
    Swap the model's total fields for the ones read from the Total row. A model total/tax
    field whose value matches a Total-row value is dropped, since the model often gets the
    name wrong. Returns (fields, notes).
    """
    if not table_totals:
        return header_fields, []
    total_values = {re.sub(r"[,\s]", "", t["value"]) for t in table_totals}
    kept, notes = [], []
    for field in header_fields:
        name = str(field.get("field", ""))
        value = re.sub(r"[,\s]", "", str(field.get("value", "")))
        if re.search(r"total|amount|quantity|qty|tax|igst|cgst|sgst", name, re.IGNORECASE) \
                and value in total_values:
            notes.append(f"'{name}' = '{field.get('value')}' replaced by the table's Total row")
            continue
        kept.append(field)
    return kept + table_totals, notes


def verify_line_items_against_text(columns: list, rows: list, all_text: str) -> list:
    """
    TEXT mode only: flag line-item values that don't appear in the PDF text. Multi-word
    values pass if every word is found (descriptions joined across lines or pages).
    """
    source = flat(all_text)
    misses = []
    for r, row in enumerate(rows, start=1):
        for c, value in enumerate(row):
            value = str(value).strip()
            if not value or flat(value) in source:
                continue
            if all(flat(tok) in source for tok in value.split()):
                continue
            col = columns[c] if c < len(columns) else f"column {c + 1}"
            misses.append(f"row {r} '{col}' = '{value}'")
    if not misses:
        return []
    shown = "; ".join(misses[:10]) + (f"; ... and {len(misses) - 10} more" if len(misses) > 10 else "")
    return [f"{len(misses)} line-item value(s) not found in the PDF text, the model may have "
            f"retyped or reformatted them: {shown}"]


# --- header fields (runs in parallel with the tables) ---

def render_header_pages_to_png(pdf_bytes: bytes, dpi: int = VISION_IMAGE_DPI) -> tuple:
    """Render just the header pages to PNG."""
    if fitz is None:
        raise RuntimeError("pymupdf is required for vision extraction. Run: pip install pymupdf")

    images = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    zoom = dpi / 72
    matrix = fitz.Matrix(zoom, zoom)
    try:
        total_pages = doc.page_count
        page_indices = get_header_page_indices(total_pages)
        for idx in page_indices:
            if 0 <= idx < total_pages:
                pix = doc[idx].get_pixmap(matrix=matrix)
                images.append(pix.tobytes("png"))
    finally:
        doc.close()
    return page_indices, images


# shared by TEXT and VISION header prompts; asks for totals too since there's no line-items file
HEADER_RULES = """WHAT TO EXTRACT
Every labelled business field in the header area, for example: buyer / company name, PAN, CIN, \
GSTIN / GST No., warehouse or facility name, contact names, phone numbers, emails, vendor / \
supplier name, vendor number / code, vendor address, PO number (for stock transfers: STR / STN / \
STO number), PO date, PO type, PO expiry / validity date, delivery date, currency, payment terms, \
delivered-by / ship-from details, delivered-to / ship-to / bill-to details, SPOC details, \
reference numbers, place of supply, reverse charge — AND any total/summary amounts printed on \
the page (Total Quantity, Total Items, Total Taxable Amount, Total Tax, Grand Total Amount, \
Cart Discount, Amount in Words, etc.).

WHAT NOT TO EXTRACT
- Individual line items (product rows) — those are handled separately.
- Terms & conditions, remarks, legal boilerplate, signature blocks, page numbers, logos.

HOW TO PAIR LABELS WITH VALUES
- A value belongs to the label printed immediately before it, usually separated by ":".
- Header boxes are often laid out in two or more columns side by side. Read each column top to \
bottom on its own; never combine text from neighbouring columns into one value.
- A label may be wrapped onto two lines (e.g. "Delivered" / "By", "PO delivery" / "date") — \
treat it as one label.
- Every label is its own field. Never put two labels' values into one field. If a value you \
are writing would run into the next label's value (e.g. a PO number followed by a date), stop — \
that is two separate fields.
- If a label has no value printed after it (e.g. "Reference :" or "PO Type :" followed by \
nothing), omit it — never borrow the next label's value for it.
- When the same label appears in different blocks (e.g. "PAN", "GST No.", "Address" for both \
the buyer and the vendor), name each after its block: "Buyer PAN", "Vendor PAN", \
"Delivered To GST No.", "Delivered By Address", etc.
- A PO usually prints MORE THAN ONE GST No. / GSTIN — typically the vendor's / supplier's and \
the buyer's (next to Delivered To / Ship To / Bill To / Billing Address). Return EVERY GST No. \
printed on the page, each named after the party or block it belongs to. Before answering, scan \
the whole header once more — every box, including right-hand columns — and make sure no \
labelled value has been skipped.
- Every GSTIN, PAN and CIN printed in the header must be returned as its own field.
- An address block often starts with a line that is only the location's NAME (e.g. a \
warehouse or facility name), followed by the street address lines. Return that first line as \
"<Block> Name" and the remaining lines as "<Block> Address".
- Every field name must be unique — never return the same name twice.
- A value may start with a leftover label fragment (e.g. "GST: 27ABCDE1234F1Z5"); return only \
the value itself.
- A title can carry a value with no label of its own (e.g. "Purchase Order 4502349805" or \
"Purchase Order | 4502349805" — that number is the PO Number); use it if the same value isn't \
labelled elsewhere. A title or heading on its own is not a field.

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

VISION_MODE_INTRO = """You are extracting HEADER-LEVEL fields from a Purchase Order / Stock Transfer \
document. The attached image(s) are the first page (and, if provided, the last page) of the \
document — read them visually, exactly as a human would. Every character matters: these values \
are loaded into an ERP system without anyone re-typing them.

"""

TEXT_MODE_INTRO = """You are extracting HEADER-LEVEL fields from a Purchase Order / Stock Transfer \
document. Below is the embedded text layer of its first page (and, if there is more than one \
page, its last page and the page that prints the totals), extracted by a PDF library — these are \
the document's exact characters, nothing has been misread, so copy values character for character.

Each page is given in TWO views of the same text:
- READING ORDER — the PDF's internal order. Multi-line values (addresses, email lists) stay \
together here, but a label and its value are often on separate lines, and some systems (e.g. \
SAP) print a whole block of labels, then a block of ":", then a block of values.
- VISUAL LINES — the text rebuilt line by line as it looks on the page, left to right, with \
" | " marking a wide gap between side-by-side boxes. Here each label sits on the same line as \
its value, and a label with nothing after it on its line (e.g. "Validity End Date :") is BLANK. \
Leading spaces show where a line starts across the page: a line on its own belongs to the box \
above it that starts at the same position (e.g. a "GST #" line indented under "Ship To" is the \
Ship To GST, one at the left edge under "Vendor" is the vendor's).
Name every block after its heading AS PRINTED (Vendor, Bill To, Ship To, ...).
Use VISUAL LINES to decide which value belongs to which label (and which labels are blank), and \
READING ORDER to assemble multi-line values. The text also contains the line-items table and \
terms & conditions — ignore those.

"""

VISION_HEADER_PROMPT = VISION_MODE_INTRO + HEADER_RULES


def channel_notes_block(header_notes: str = None) -> str:
    """Per-channel layout notes from channels.json, or "" if there are none."""
    if not header_notes:
        return ""
    return ("\nTHIS CHANNEL'S LAYOUT — every PO from this channel is printed this way; these notes "
            f"override the general rules above where they differ:\n{header_notes.strip()}\n")


def build_text_mode_prompt(text_info: dict, header_notes: str = None) -> str:
    parts = [TEXT_MODE_INTRO, HEADER_RULES, channel_notes_block(header_notes)]
    last = text_info["num_pages"] - 1
    for idx in text_info["header_pages"]:
        page = text_info["pages"][idx]
        which = "FIRST" if idx == 0 else ("LAST" if idx == last else "TOTALS")
        parts.append(f"\n=== PAGE {idx + 1} ({which} PAGE) — READING ORDER ===\n{page['text'].strip()}\n"
                     f"=== PAGE {idx + 1} ({which} PAGE) — VISUAL LINES ===\n{page['layout'].strip()}\n")
    parts.append("=== END OF TEXT ===\n")
    return "".join(parts)


def header_source_text(text_info: dict) -> str:
    """Both text views of the header pages, used to verify header values."""
    return "\n".join(text_info["pages"][i]["text"] + "\n" + text_info["pages"][i]["layout"]
                     for i in text_info["header_pages"])


def run_header_stage(bedrock, pdf_bytes: bytes, text_info: dict, header_notes: str = None) -> dict:
    use_text = HEADER_MODE == "text" or (HEADER_MODE == "auto" and text_info["header_ok"])
    if use_text:
        pages = [i + 1 for i in text_info["header_pages"]]
        print(f"  [Header | TEXT] page(s) {pages} from the text layer, "
              f"calling {BEDROCK_MODEL_ID}")
        result = call_model_json(bedrock, [{"text": build_text_mode_prompt(text_info, header_notes)}],
                                 f"Header fields | TEXT mode, page(s) {pages}")
        result.update(mode="TEXT", num_images=0)
    else:
        page_indices, page_images = render_header_pages_to_png(pdf_bytes)
        print(f"  [Header | VISION] {text_info['header_reason']}. Rendered page(s) "
              f"{[p + 1 for p in page_indices]} at {VISION_IMAGE_DPI} DPI, calling {BEDROCK_MODEL_ID} (vision)")
        content_blocks = [{"image": {"format": "png", "source": {"bytes": img}}} for img in page_images]
        content_blocks.append({"text": VISION_HEADER_PROMPT + channel_notes_block(header_notes)})
        result = call_model_json(bedrock, content_blocks,
                                 f"Header fields | VISION mode, {len(page_images)} page image(s)")
        result.update(mode="VISION", num_images=len(page_images))

    header_fields = tidy_header_fields(result["parsed"].get("header_fields", []))
    warnings = validate_header_fields(header_fields, header_source_text(text_info) if use_text else None)
    return {"header_fields": header_fields, "warnings": warnings, "cost": result["cost"],
            "mode": result["mode"], "num_images": result["num_images"]}


PLACEHOLDER_VALUES = {"_", "-", "--", "na", "n/a", "nil", "none", "null"}


def _same_text(a, b) -> bool:
    """Equal ignoring case, spaces and punctuation."""
    norm = lambda s: re.sub(r"[^a-z0-9]", "", str(s).lower())
    return bool(norm(a)) and norm(a) == norm(b)


def tidy_header_fields(header_fields: list) -> list:
    """
    Collapse whitespace, drop blank/placeholder values and echoed headings, and number
    duplicate field names so nothing gets overwritten when loaded by name.
    """
    for field in header_fields:
        field["value"] = " ".join(str(field.get("value", "")).split())
    # value equal to its own name is just a heading the model picked up
    echoed = [f.get("field", "") for f in header_fields if _same_text(f.get("field", ""), f["value"])]
    header_fields = [f for f in header_fields if not _same_text(f.get("field", ""), f["value"])]
    if echoed:
        print(f"  [Header] dropped {len(echoed)} heading field(s): {', '.join(echoed)}")
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


# --- header validation ---

PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# matched against lower-cased field names
IS_PAN = re.compile(r"\bpan\b")                                   # word boundary so "company" doesn't match
IS_GSTIN = re.compile(r"\bgst(in)?\b")
# PO number, or STR / STN / STO number on stock transfers
IS_PO_NUMBER = re.compile(
    r"\b(p\.?\s?o\.?|purchase order|order)\s*(number|no\.?|#|id)?\s*$|"
    r"\b(p\.?\s?o\.?|purchase order)\s*(number|no\.?|#)|"
    r"\b(str|stn|sto|stock transfer(\s+(request|note|order))?)\s*(number|no\.?|#|id)(?!\w)"
)
IS_ID_FIELD = re.compile(r"\b(number|no\.?|code|id|ref(erence)?|#)\s*$")
IS_PHONE = re.compile(r"\b(phone|mobile|tel|contact no\.?)\b")
IS_PINCODE = re.compile(r"\b(pin\s?code|pincode|postal code|zip)\b")
LOOKALIKE_BETWEEN_DIGITS = re.compile(r"(?<=[0-9])[OoIl](?=[0-9])")

# same IDs, searched for anywhere in a block of text
GSTIN_IN_TEXT = re.compile(r"(?<![A-Z0-9])[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z](?![A-Z0-9])")
PAN_IN_TEXT = re.compile(r"(?<![A-Z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Z0-9])")
CIN_IN_TEXT = re.compile(r"(?<![A-Z0-9])[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}(?![A-Z0-9])")


def _strip_to_id(value: str, pattern) -> str:
    """Strip a stuck-on label, e.g. 'GST:19AACCI2053A1Z4' becomes '19AACCI2053A1Z4'."""
    found = pattern.search(value)
    return found.group(0) if found and found.group(0) != value else value


def gstin_check_digit_ok(gstin: str) -> bool:
    """GSTIN's 15th character is a mod-36 check digit over the first 14."""
    total = 0
    for i, ch in enumerate(gstin[:14]):
        value = GSTIN_CHARSET.index(ch) * (2 if i % 2 else 1)
        total += value // 36 + value % 36
    return GSTIN_CHARSET[(36 - total % 36) % 36] == gstin[14]


def flat(text: str) -> str:
    """Normalise text for substring checks: no whitespace, commas or dash variants, lower-case."""
    text = str(text).replace("–", "-").replace("—", "-").replace("⁠", "").replace("​", "")
    return re.sub(r"[\s,;|]+", "", text).lower()


def validate_header_fields(header_fields: list, page_text) -> list:
    """
    Clean up PAN/GSTIN values in place and return a list of warnings.
    page_text is the header pages' text in TEXT mode, None in VISION mode.
    """
    warnings = []
    source = flat(page_text) if page_text else None
    pans, gstins, po_numbers = [], [], []

    for field in header_fields:
        name = str(field.get("field", ""))
        lname = name.lower()
        value = str(field.get("value", "")).strip()

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
                                f"one string, another field may have been merged into it.")

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

    # GSTIN chars 3-12 are the owner's PAN; a PAN that's 1-3 chars off means one was misread
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

    # TEXT mode: every GSTIN / PAN / CIN on the page should come back as its own field
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


# --- stacked-cell tables (channel setting "stacked_table", e.g. Reliance) ---
# Each heading cell names several values printed one per line ("Article No.\nHSN Code"), and
# each item cell holds those values in the same order. The table is read straight from the
# text layer, no model call, so the values are exact and there's no output-size limit.

def _cell_lines(cell) -> list:
    return [ln.strip() for ln in str(cell or "").split("\n") if ln.strip()]


def split_stacked_cell(cell, n: int) -> list:
    """A cell's lines spread over n sub-columns. Extra lines at the top belong to the first
    one (a wrapped description above Delivery Date / Site); missing lines are left blank."""
    if n == 1:
        return [join_cell_lines(cell)]
    lines = _cell_lines(cell)
    if len(lines) > n:
        lines = [" ".join(lines[:len(lines) - n + 1])] + lines[len(lines) - n + 1:]
    return lines + [""] * (n - len(lines))


def read_stacked_table(pdf_bytes: bytes, first_header: str) -> dict:
    """
    Line items from every table whose heading row starts with first_header (repeated on each
    page), plus the labelled total rows after the items ("Grand Total of Qty", "TOTAL IGST").
    Returns {"columns", "rows", "totals"}.
    """
    columns, spans, rows, totals = None, None, [], []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        for page in doc:
            with contextlib.redirect_stdout(io.StringIO()):   # PyMuPDF prints a tip here
                found = page.find_tables()
            for table in found.tables:
                grid = table.extract()
                if not grid or _norm_col(join_cell_lines(grid[0][0])) != _norm_col(first_header):
                    continue
                spans = [max(1, len(_cell_lines(c))) for c in grid[0]]
                names = [name for c in grid[0] for name in (_cell_lines(c) or [""])]
                if columns is None:
                    columns = names
                elif names != columns:
                    raise RuntimeError(f"page {page.number + 1}: the items table has different columns "
                                       f"than page 1's ({names} vs {columns})")
                for row in grid[1:]:
                    cells = [str(c or "") for c in row]
                    if _serial_no([cells[0].strip()]):
                        rows.append([v for c, n in zip(cells, spans) for v in split_stacked_cell(c, n)])
                        continue
                    labels = [c.strip() for c in cells if c.strip() and not _is_number(c)]
                    numbers = [c.strip() for c in cells if c.strip() and _is_number(c)]
                    if labels and numbers:
                        totals.append({"field": labels[0].rstrip(":").strip(), "value": numbers[-1],
                                       "confidence": "exact (items table total row)"})
    finally:
        doc.close()
    if not rows:
        raise RuntimeError(f"no items table starting with '{first_header}' found in the PDF text layer")
    return {"columns": columns, "rows": rows, "totals": totals}


def check_stacked_totals(columns: list, rows: list, totals: list, total_columns: dict) -> tuple:
    """
    Each printed total checked against the sum of its column(s): total_columns is
    {"<total label>": "<column>" or ["<column>", ...]} from channels.json.
    Returns (warnings, summary).
    """
    names = [_norm_col(c) for c in columns]
    by_label = {_norm_col(t["field"]): t for t in totals}
    warnings, checked = [], []
    for label, cols in total_columns.items():
        total = by_label.get(_norm_col(label))
        if total is None:
            warnings.append(f"Total row '{label}' was not found in the items table.")
            continue
        cols = [cols] if isinstance(cols, str) else cols
        missing = [c for c in cols if _norm_col(c) not in names]
        if missing:
            warnings.append(f"Total '{label}': no column {missing} in the items table to check it against.")
            continue
        values = [_to_num(r[names.index(_norm_col(c))]) for r in rows for c in cols]
        actual = sum(v for v in values if v is not None)
        expected = _to_num(total["value"])
        tolerance = 0.001 if all(_norm_col(c) in QTY_COLUMNS for c in cols) else max(0.05, 0.01 * len(rows))
        if expected is None or abs(expected - actual) > tolerance:
            warnings.append(f"Table '{total['field']}' = {total['value']}, but {' + '.join(cols)} "
                            f"add(s) up to {actual:,.2f}")
        checked.append(total["field"])
    return warnings, f"totals check: {', '.join(checked) or 'none'} vs the line items"


def process_stacked(pdf_path: str, pdf_bytes: bytes, text_info: dict, clients: dict,
                    header_notes: str, stacked_table: dict, run_started: float) -> dict:
    """process() for a channel with "stacked_table": header from the model, items read by rule."""
    if not text_info["all_pages_ok"]:
        raise PipelineError(f"stacked_table needs a usable text layer on every page "
                            f"({text_info['all_pages_reason']})")
    try:
        items = read_stacked_table(pdf_bytes, stacked_table["first_header"])
    except (RuntimeError, KeyError) as e:
        raise PipelineError(f"reading the items table: {e}") from e
    columns, rows, table_totals = items["columns"], items["rows"], items["totals"]
    print(f"  [Line items | stacked table] {len(rows)} item(s), {len(columns)} column(s), "
          f"{len(table_totals)} total row(s), read from the text layer (no model call)")

    line_warnings, arithmetic_summary = validate_line_items(columns, rows)
    print(f"  [Line items] {arithmetic_summary}")
    totals_warnings, totals_summary = check_stacked_totals(columns, rows, table_totals,
                                                           stacked_table.get("totals", {}))
    print(f"  [Totals] {totals_summary}")

    try:
        header_result = run_header_stage(clients["bedrock"], pdf_bytes, text_info, header_notes)
    except NoCredentialsError as e:
        raise PipelineError("No AWS credentials found. Run `aws configure` first.") from e
    except Exception as e:
        raise PipelineError(f"header fields: {e}") from e
    header_fields, totals_notes = merge_table_totals(header_result["header_fields"], table_totals)
    for note in totals_notes:
        print(f"  [Totals] {note}")
    header_only = [f for f in header_fields if f not in table_totals]

    all_warnings = header_result["warnings"] + line_warnings + totals_warnings
    print(f"\nExtracted {len(header_only)} header field(s) ({header_result['mode']}) and "
          f"{len(rows)} line item(s) (stacked table)\n")
    if all_warnings:
        print(f"Validation: {len(all_warnings)} issue(s) to review:")
        for w in all_warnings:
            print(f"  - {w}")
    else:
        print("Validation: no issues")
    print(f"\nCost:\n  Line items (text layer):  $0.0000\n"
          f"  Model, header ({header_result['mode']} mode):  ${header_result['cost']:.4f}\n"
          f"  TOTAL:  ${header_result['cost']:.4f}\n")
    print(f"Took {time.time() - run_started:.1f}s")
    return build_output(header_only, table_totals, columns, rows, all_warnings)


def process(pdf_path: str, clients: dict = None, header_notes: str = None,
            split_value_rate_cells_enabled: bool = False, unlabeled_total_row: bool = False,
            stacked_table: dict = None) -> dict:
    """
    Run the full pipeline on one PO and return the extracted data as a dict. Raises PipelineError.
    header_notes are optional per-channel notes added to the header prompt.
    split_value_rate_cells_enabled and unlabeled_total_row are per-channel layout settings,
    see split_value_rate_cells() and find_table_totals(). stacked_table switches the line
    items to read_stacked_table() (no model call), see process_stacked().
    Called from run_po.py and main().
    """
    run_started = time.time()
    total_llm_cost = 0.0
    print(f"Reading from: {pdf_path}\n")

    clients = clients or make_clients()

    try:
        pdf_bytes = read_pdf_bytes(clients["s3"], pdf_path)
        text_info = inspect_text_layer(pdf_bytes)
    except NoCredentialsError as e:
        raise PipelineError("No AWS credentials found. Run `aws configure` first.") from e
    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "Unknown")
        raise PipelineError(f"{error_code} - {e}") from e
    except (OSError, ValueError, RuntimeError) as e:
        raise PipelineError(str(e)) from e

    print(f"  [Text layer] {text_info['num_pages']} page(s) | header pages: "
          f"{'ok' if text_info['header_ok'] else 'not usable'} ({text_info['header_reason']}) | "
          f"all pages: {'ok' if text_info['all_pages_ok'] else 'not usable'} ({text_info['all_pages_reason']})\n")

    if stacked_table:
        return process_stacked(pdf_path, pdf_bytes, text_info, clients, header_notes, stacked_table, run_started)

    # tables and header run side by side; line items wait for the tables
    print("Running tables and header in parallel\n")
    pool = ThreadPoolExecutor(max_workers=2)
    tables_future = pool.submit(run_tables_stage, clients["textract"], pdf_path, pdf_bytes, text_info)
    header_future = pool.submit(run_header_stage, clients["bedrock"], pdf_bytes, text_info, header_notes)

    try:
        tables_result = tables_future.result()
    except NoCredentialsError as e:
        pool.shutdown(wait=False, cancel_futures=True)
        raise PipelineError("No AWS credentials found. Run `aws configure` first.") from e
    except ClientError as e:
        pool.shutdown(wait=False, cancel_futures=True)
        error_code = e.response.get("Error", {}).get("Code", "Unknown")
        raise PipelineError(f"{error_code} - {e}") from e
    except (RuntimeError, TimeoutError) as e:
        pool.shutdown(wait=False, cancel_futures=True)
        raise PipelineError(str(e)) from e

    table_source = tables_result["source"]
    num_pages = tables_result["num_pages"]
    all_tables, unstack_notes = unstack_two_row_items(tables_result["all_tables"])
    for note in unstack_notes:
        print(f"  [Tables] {note}")
    pages_with_tables = sorted({t["page"] for t in all_tables})
    print(f"\nTables [{table_source}]: {len(all_tables)} table(s) on "
          f"page(s) {pages_with_tables}, {num_pages} page(s) total")

    textract_cost = num_pages * TEXTRACT_TABLES_COST_PER_PAGE if table_source == "TEXTRACT" else 0.0
    if table_source == "TEXTRACT":
        print(f"  [Textract] {num_pages} page(s) x ${TEXTRACT_TABLES_COST_PER_PAGE}/page "
              f"= ${textract_cost:.4f}\n")
    else:
        print("  [Textract] not used, $0.0000\n")

    try:
        line_result = run_line_items_stage(clients["bedrock"], all_tables, table_source)
    except Exception as e:
        pool.shutdown(wait=False, cancel_futures=True)
        raise PipelineError(f"calling Bedrock (line items): {e}") from e
    total_llm_cost += line_result["cost"]

    line_columns = line_result["columns"]
    line_rows, continuation_notes = attach_continuation_descriptions(all_tables, line_result["rows"])
    for note in continuation_notes:
        print(f"  [Line items] {note}")
    row_confidences = align_row_confidences(all_tables, line_columns, line_rows)
    if split_value_rate_cells_enabled:
        line_columns, line_rows, split_notes = split_value_rate_cells(line_columns, line_rows)
        for note in split_notes:
            print(f"  [Line items] {note}")

    line_warnings, arithmetic_summary = validate_line_items(line_columns, line_rows)
    print(f"  [Line items] {arithmetic_summary}")
    if table_source == "TEXT":
        # include the table text too, it has wrapped values (like a split HSN) already joined
        all_text = "\n".join(p["text"] for p in text_info["pages"]) + "\n" + all_tables_to_text(all_tables)
        line_warnings += verify_line_items_against_text(line_columns, line_rows, all_text)

    try:
        header_result = header_future.result()
    except NoCredentialsError as e:
        raise PipelineError("No AWS credentials found. Run `aws configure` first.") from e
    except Exception as e:
        raise PipelineError(f"header fields: {e}") from e
    finally:
        pool.shutdown()
    total_llm_cost += header_result["cost"]

    # take totals from the table's Total row rather than trusting the model's names for them
    table_totals = find_table_totals(all_tables, unlabeled_total_row)
    header_fields, totals_notes = merge_table_totals(header_result["header_fields"], table_totals)
    for note in totals_notes:
        print(f"  [Totals] {note}")
    totals_warnings, totals_summary = reconcile_table_totals(line_columns, line_rows, table_totals)
    print(f"  [Totals] {totals_summary}")
    line_warnings += totals_warnings

    print(f"\nExtracted {len(header_fields)} header field(s) ({header_result['mode']}) and "
          f"{len(line_rows)} line item(s) ({table_source} tables)\n")

    all_warnings = header_result["warnings"] + line_warnings
    if all_warnings:
        print(f"Validation: {len(all_warnings)} issue(s) to review:")
        for w in all_warnings:
            print(f"  - {w}")
    else:
        print("Validation: no issues")

    low_confidence_rows = [
        i + 1 for i, c in enumerate(row_confidences) if c is not None and c < 90
    ]
    if low_confidence_rows:
        print(f"  - Rows with Textract confidence under 90%: {low_confidence_rows}")

    header_label = (f"{header_result['mode']} mode"
                    + (f", {header_result['num_images']} pg" if header_result["mode"] == "VISION" else ""))
    print(f"\nCost:")
    print(f"  Textract ({num_pages if table_source == 'TEXTRACT' else 0} page(s)):          ${textract_cost:.4f}")
    print(f"  Model, line items ({table_source}):       ${line_result['cost']:.4f}")
    print(f"  Model, header ({header_label}):     ${header_result['cost']:.4f}")
    print(f"  TOTAL:                            ${textract_cost + total_llm_cost:.4f}\n")

    print(f"Took {time.time() - run_started:.1f}s")
    # merge_table_totals appended the Total-row values to the header list; return them separately
    header_only = [f for f in header_fields if f not in table_totals]
    return build_output(header_only, table_totals, line_columns, line_rows, all_warnings)


def main():
    if len(sys.argv) != 2:
        print("Usage: python extract_hybrid_text_first_v2.py <pdf: s3://bucket/key or local path>")
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
