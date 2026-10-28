"""
Run PO extraction for a channel and print the extracted PO as JSON.

Picks the pipeline from the files passed in:
    pdf + sheet  extract_text_first_excel_v2   (blinkit, myntra)
    pdf only     extract_hybrid_text_first_v2  (purple, avenue)
    sheet only   extract_excel_only_v2         (flipkart, bigbasket, firstcry, scootsy)
    flat csv     extract_flat_csv              (zepto, tat; set by "pipeline": "flat_csv")

Channel settings come from channels.json. If a channel's "expects" doesn't match the
files given, the run is refused. Nothing is written to disk and nothing is printed while
it runs: the only output is the extracted PO as one JSON on stdout, which the backend
reads in memory (`> po.json` captures it by hand). From Python, call route(channel, files)
to get the same data as a dict.

Usage:
    python run_po.py <channel> <file> [<file>]

    python run_po.py blinkit blinkit_1.pdf blinkit_2.xlsx
    python run_po.py purple s3://my-bucket/purple/purple_po.PDF
    python run_po.py zepto zepto_po.csv > zepto.json

Files can be local or s3:// paths, in any order.
Exit codes: 0 ok, 1 pipeline or other error, 2 bad arguments. On an error the JSON is
{"channel": ..., "error": ...}.
"""

import os
import re
import sys
import json
import argparse
import contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import extract_text_first_excel_v2 as pdf_plus_sheet_pipeline
import extract_hybrid_text_first_v2 as pdf_only_pipeline
import extract_excel_only_v2 as sheet_only_pipeline
import extract_flat_csv as flat_csv_pipeline

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
        raise UsageError(f"first argument should be a channel name (blinkit, purple, ...), got '{channel}'. "
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
        result = flat_csv_pipeline.process(sheet, header_columns=cfg.get("header_columns"))
    elif received == "pdf+sheet":
        result = pdf_plus_sheet_pipeline.process(pdf, sheet)
    elif received == "pdf":
        result = pdf_only_pipeline.process(pdf, header_notes=cfg.get("header_notes"))
    else:
        result = sheet_only_pipeline.process(sheet)
    return {"channel": channel, "input": received, "pdf": pdf, "sheet": sheet, **result}


def main():
    parser = argparse.ArgumentParser(description="Extract a PO for any channel (see channels.json).")
    parser.add_argument("channel", help="channel name, e.g. blinkit, purple, flipkart")
    parser.add_argument("files", nargs="+", help="the PO file(s): a PDF, a spreadsheet, or both (local or s3://)")
    args = parser.parse_args()

    try:
        # Quiet run: the pipelines' progress lines and warnings are dropped, the JSON below is the only output
        with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            output, code = route(args.channel, args.files), 0
    except UsageError as e:
        output, code = {"channel": args.channel, "error": str(e)}, 2
    except PIPELINE_ERRORS as e:
        output, code = {"channel": args.channel, "error": str(e)}, 1
    except Exception as e:                         # S3 / Bedrock / Textract / an unreadable file: same JSON, no traceback
        output, code = {"channel": args.channel, "error": f"{type(e).__name__}: {e}"}, 1
    sys.stdout.reconfigure(encoding="utf-8")       # Windows defaults to cp1252 when redirected
    print(json.dumps(output, ensure_ascii=False))
    sys.exit(code)


if __name__ == "__main__":
    main()
