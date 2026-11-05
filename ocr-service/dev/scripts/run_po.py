"""
Run PO extraction for a channel and print the extracted PO as JSON.

Picks the pipeline from the files passed in:
    pdf + sheet  extract_text_first_excel_v2   (blinkit, myntra, zepto)
    pdf only     extract_hybrid_text_first_v2  (purplle, avenue)
    sheet only   extract_excel_only_v2         (flipkart, bigbasket, firstcry, scootsy)
    flat csv     extract_flat_csv              (tat; set by "pipeline": "flat_csv")

Channel settings come from channels.json. If a channel's "expects" doesn't match the
files given, the run is refused. Nothing is written to disk and nothing is printed while
it runs: the only output is the extracted PO as one JSON on stdout, which the backend
reads in memory (`> po.json` captures it by hand). From Python, call route(channel, files)
to get the same data as a dict.

Usage:
    python run_po.py <channel> <file> [<file>]

    python run_po.py blinkit blinkit_1.pdf blinkit_2.xlsx
    python run_po.py purplle s3://my-bucket/purplle/purplle_po.PDF
    python run_po.py zepto P6110725.pdf P6110725.csv > zepto.json

Files can be local or s3:// paths, in any order.
Exit codes: 0 ok, 1 pipeline or other error, 2 bad arguments. On an error the JSON is
{"channel": ..., "error": ..., "error_type": ..., "error_code": ...}.

Both on success and on an error the JSON also carries "ocr_run" (POST_FG 2026-11-05, for its logs): the stage reached
(where it failed), the page decisions, every paid call (model tokens + cost, Textract pages + cost), the totals,
duration_ms and "log" = the last progress lines of the pipeline (kept in memory, not printed).
"""

import os
import re
import sys
import json
import argparse
import contextlib
import io
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import extract_text_first_excel_v2 as pdf_plus_sheet_pipeline
import extract_hybrid_text_first_v2 as pdf_only_pipeline
import extract_excel_only_v2 as sheet_only_pipeline
import extract_flat_csv as flat_csv_pipeline
import run_report

# How many of the pipeline's last progress lines go back with the JSON (ocr_run.log): enough to see the path and the error.
LOG_TAIL_LINES = 60

CHANNELS_FILE = os.path.join(HERE, "channels.json")
PIPELINE_ERRORS = (pdf_plus_sheet_pipeline.PipelineError, pdf_only_pipeline.PipelineError,
                   sheet_only_pipeline.PipelineError, flat_csv_pipeline.PipelineError)


class UsageError(Exception):
    pass


def load_channel_config(channel: str) -> dict:
    """Channel settings merged over "default"."""
    with open(CHANNELS_FILE, encoding="utf-8") as f:
        channels = {k.lower(): v for k, v in json.load(f).items() if not k.startswith("_")}
    cfg = dict(channels.get("default", {}))
    if channel in channels:
        cfg.update(channels[channel])
    else:
        print(f"[run_po] channel '{channel}' not in channels.json, using defaults")
    return cfg


def is_pdf(path: str) -> bool:
    if path.lower().endswith(".pdf"):
        return True
    if not path.startswith("s3://") and os.path.isfile(path):
        with open(path, "rb") as f:
            return f.read(5) == b"%PDF-"
    return False


def sort_files(files: list) -> tuple:
    """Returns (pdf, sheet)."""
    pdfs = [f for f in files if is_pdf(f)]
    sheets = [f for f in files if not is_pdf(f)]
    if len(pdfs) > 1 or len(sheets) > 1:
        raise UsageError(f"expected at most one PDF and one spreadsheet, got {len(pdfs)} PDF(s) "
                         f"and {len(sheets)} other file(s): {files}")
    for f in files:
        if not f.startswith("s3://") and not os.path.isfile(f):
            raise UsageError(f"file not found: {f}")
    return (pdfs[0] if pdfs else None), (sheets[0] if sheets else None)


CHANNEL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]*$")


def check_channel_name(channel: str):
    # catches a missing channel argument (file path passed first)
    looks_like_file = ("://" in channel or "/" in channel or "\\" in channel
                       or os.path.splitext(channel)[1].lower() in (".pdf", ".xls", ".xlsx", ".xlsm", ".csv", ".tsv", ".txt"))
    if looks_like_file or not CHANNEL_NAME_RE.match(channel):
        raise UsageError(f"first argument should be a channel name (blinkit, purplle, ...), got '{channel}'. "
                         f"Usage: python run_po.py <channel> <file> [<file>]")


def route(channel: str, files: list) -> dict:
    """Runs the right pipeline and returns the extracted PO as a dict."""
    channel = channel.strip().lower()
    check_channel_name(channel)
    cfg = load_channel_config(channel)
    pdf, sheet = sort_files(files)
    received = "pdf+sheet" if pdf and sheet else "pdf" if pdf else "sheet"

    expected = cfg.get("expects")
    if expected and expected != received:
        raise UsageError(f"channel '{channel}' expects {expected}, got {received} "
                         f"(pdf={pdf}, sheet={sheet})")
    print(f"[run_po] channel={channel} | input={received}\n")

    if cfg.get("pipeline") == "flat_csv":
        if received != "sheet":
            raise UsageError(f"channel '{channel}' uses the flat csv pipeline, pass just the csv")
        result = flat_csv_pipeline.process(sheet, header_columns=cfg.get("header_columns"),
                                           filename_fields=cfg.get("filename_fields"))
    elif received == "pdf+sheet":
        # every per-channel setting of channels.json goes to its pipeline (2026-10-28: before, only
        # header_notes did, so e.g. Reliance's stacked_table was never used and its stacked cells were glued)
        result = pdf_plus_sheet_pipeline.process(pdf, sheet, header_notes=cfg.get("header_notes"),
                                                 pdf_totals=cfg.get("pdf_totals"),
                                                 read_last_page=bool(cfg.get("read_last_page")))
    elif received == "pdf":
        result = pdf_only_pipeline.process(pdf, header_notes=cfg.get("header_notes"),
                                           split_value_rate_cells_enabled=bool(cfg.get("split_value_rate_cells")),
                                           unlabeled_total_row=bool(cfg.get("unlabeled_total_row")),
                                           stacked_table=cfg.get("stacked_table"),
                                           line_notes=cfg.get("line_notes"),
                                           header_pages=cfg.get("header_pages"))
    else:
        result = sheet_only_pipeline.process(sheet)
    return {"channel": channel, "input": received, "pdf": pdf, "sheet": sheet, **result}


def aws_error_code(e: BaseException):
    """The AWS error code behind an error (InvalidS3ObjectException, AccessDeniedException ...), else None."""
    seen = 0
    while e is not None and seen < 5:
        response = getattr(e, "response", None)
        if isinstance(response, dict) and response.get("Error", {}).get("Code"):
            return response["Error"]["Code"]
        e, seen = e.__cause__ or e.__context__, seen + 1
    return None


def main():
    parser = argparse.ArgumentParser(description="Extract a PO for any channel (see channels.json).")
    parser.add_argument("channel", help="channel name, e.g. blinkit, purplle, flipkart")
    parser.add_argument("files", nargs="+", help="the PO file(s): a PDF, a spreadsheet, or both (local or s3://)")
    args = parser.parse_args()

    run_report.reset()
    started = time.time()
    captured = io.StringIO()
    try:
        # Quiet run: the pipelines' progress lines and warnings are kept in memory (their tail goes back in
        # ocr_run.log), the JSON below is the only output
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            output, code = route(args.channel, args.files), 0
    except UsageError as e:
        output, code = {"channel": args.channel, "error": str(e), "error_type": "UsageError"}, 2
    except PIPELINE_ERRORS as e:
        output, code = {"channel": args.channel, "error": str(e), "error_type": type(e).__name__,
                        "error_code": aws_error_code(e)}, 1
    except Exception as e:                         # S3 / Bedrock / Textract / an unreadable file: same JSON, no traceback
        output, code = {"channel": args.channel, "error": f"{type(e).__name__}: {e}", "error_type": type(e).__name__,
                        "error_code": aws_error_code(e)}, 1
    lines = [line for line in captured.getvalue().splitlines() if line.strip()]
    output["ocr_run"] = {**run_report.summary(), "duration_ms": int((time.time() - started) * 1000),
                         "log": lines[-LOG_TAIL_LINES:]}
    sys.stdout.reconfigure(encoding="utf-8")       # Windows defaults to cp1252 when redirected
    print(json.dumps(output, ensure_ascii=False))
    sys.exit(code)


if __name__ == "__main__":
    main()
