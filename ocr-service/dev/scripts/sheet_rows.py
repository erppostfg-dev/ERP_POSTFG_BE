"""
Read a sheet file (.xls / .xlsx / .csv) into its rows as JSON, with NO model call and no cost (POST_FG 2026-11-05: Noble
Chemist sends an old-style .xls that the backend's own reader cannot open). Reuses the sheet readers of
extract_excel_only_v2 (xlrd for .xls, openpyxl for .xlsx; dates as YYYY-MM-DD).

Usage: python sheet_rows.py <file>   ->   {"format": "xls", "rows": [["cell", ...], ...]}   (or {"error": ...}, exit 1)
"""

import contextlib
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: sheet_rows.py <file>"}))
        sys.exit(2)
    path = sys.argv[1]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            import extract_excel_only_v2 as sheets
            with open(path, "rb") as f:
                data = f.read()
            fmt, rows = sheets.read_sheet_rows(path, data)
        out, code = {"format": fmt, "rows": rows}, 0
    except Exception as e:  # an unreadable file: the reason, no traceback
        out, code = {"error": f"{type(e).__name__}: {e}"}, 1
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(code)


if __name__ == "__main__":
    main()
