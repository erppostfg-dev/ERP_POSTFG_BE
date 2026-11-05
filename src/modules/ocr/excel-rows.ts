import { execFile } from 'child_process';
import path from 'path';
import { env } from '../../config/env';
import { OCR_SHEET } from '../../constants';

/*
 * An Excel file (.xls / .xlsx) as text rows, for the sheet reader (2026-11-05: Noble Chemist's old-style .xls, which no
 * Node reader here opens). Runs ocr-service/dev/scripts/sheet_rows.py with the OCR's Python (PYTHON_BIN, xlrd /
 * openpyxl already installed for the OCR): it only reads the file, no model call, no cost.
 */
export const excelRows = (file: string): Promise<string[][]> =>
  new Promise((resolve, reject) => {
    const pythonBin = /[\\/]/.test(env.ocr.pythonBin) ? path.resolve(env.ocr.pythonBin) : env.ocr.pythonBin;
    const script = path.join(path.dirname(path.resolve(env.ocr.script)), OCR_SHEET.SCRIPT);
    execFile(pythonBin, [script, file], {
      timeout: OCR_SHEET.TIMEOUT_MS, maxBuffer: OCR_SHEET.MAX_OUTPUT_BYTES, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    }, (err, stdout) => {
      let out: { rows?: string[][]; error?: string } = {};
      try {
        out = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as typeof out;
      } catch {
        // no JSON: the error below says why
      }
      if (out.rows) return resolve(out.rows);
      reject(new Error(`${path.basename(file)}: ${out.error ?? err?.message ?? 'the sheet could not be read'}`));
    });
  });
