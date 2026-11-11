import { spawn } from 'child_process';
import path from 'path';
import { env } from '../../config/env';
import { LOG_SOURCE } from '../../constants/logging';
import { logFailure, writeLog } from '../../utils/logger';

export interface OcrRun {
  /** run_po.py exit code: 0 ok, 1 pipeline error, 2 bad arguments; null if it was killed or did not start. */
  exitCode: number | null;
  /** The JSON run_po.py printed on stdout: the extracted PO, or { channel, error }. Undefined if none / not JSON. */
  result?: Record<string, unknown>;
  timedOut: boolean;
  /** Last part of what the OCR wrote to stderr (normally nothing: run_po.py runs quiet), for debugging. */
  logTail: string;
  durationMs: number;
  /** stdout that was NOT the JSON (stray lines before it, or no JSON at all): its last part, for debugging. */
  stdoutTail?: string;
}

/** Who the run is for, only for the log lines (the PO folder and the channel). */
export interface OcrRunContext {
  folder?: string;
  channel?: string;
}

/** What run_po.py reports about the run (ocr_run, 2026-11-05): where it got to, the page decisions, every paid call. */
export interface OcrRunReport {
  stage?: string;
  notes?: { pages?: { page: number; blank: boolean; usable: boolean; reason: string }[]; header_pages?: number[]; tables_source?: string; header_mode?: string };
  calls?: { label: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number }[];
  totals?: { model_calls: number; input_tokens: number; output_tokens: number; textract_pages: number; model_cost_usd: number; textract_cost_usd: number; cost_usd: number };
  duration_ms?: number;
  log?: string[];
}

/** Lines of the OCR's own progress log put on a failure line (the end shows the path taken and the error). */
const FAILURE_LOG_LINES = 25;

/**
 * run_po.py's JSON from its stdout (2026-11-05): the whole output, else the LAST line that is a JSON object (a stray
 * line before it, e.g. a background job printing late, used to make the whole run unreadable: "OCR exited with code 1"
 * and no reason). stray = the rest, kept for debugging.
 */
export const parseOcrStdout = (text: string): { result?: Record<string, unknown>; stray?: string } => {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return { result: JSON.parse(trimmed) as Record<string, unknown> };
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      try {
        return { result: JSON.parse(line) as Record<string, unknown>, stray: lines.filter((_, j) => j !== i).join('\n').slice(-LOG_TAIL_CHARS) };
      } catch {
        // not this line
      }
    }
    return { stray: trimmed.slice(-LOG_TAIL_CHARS) };
  }
};

/** The facts of one OCR run for its log lines: path, pages, tokens and cost (USD, as AWS bills). */
export interface OcrRunFacts {
  stage?: string; pages?: number; blankPages?: string; unusablePages?: string; headerPages?: string; tablesSource?: string; headerMode?: string;
  model?: string; modelCalls?: number; modelIn?: number; modelOut?: number; textractPages?: number;
  modelCostUsd?: number; textractCostUsd?: number; costUsd?: number;
}
export const ocrRunFacts = (report: OcrRunReport | undefined): OcrRunFacts => {
  if (!report) return {};
  const t = report.totals;
  const n = report.notes ?? {};
  return {
    stage: report.stage,
    pages: n.pages?.length,
    blankPages: n.pages?.filter((p) => p.blank).map((p) => p.page).join(',') || undefined,
    unusablePages: n.pages?.filter((p) => !p.usable).map((p) => `${p.page}: ${p.reason}`).join('; ') || undefined,
    headerPages: n.header_pages?.join(','),
    tablesSource: n.tables_source,
    headerMode: n.header_mode,
    model: report.calls?.[0]?.model,
    modelCalls: t?.model_calls,
    // model tokens in / out (field names without "token": the logger masks those as secrets)
    modelIn: t?.input_tokens,
    modelOut: t?.output_tokens,
    textractPages: t?.textract_pages,
    modelCostUsd: t?.model_cost_usd,
    textractCostUsd: t?.textract_cost_usd,
    costUsd: t?.cost_usd,
  };
};

const LOG_TAIL_CHARS = 8000;
/** Most of the OCR's stdout kept (the PO as JSON); anything over it is dropped and the JSON fails to parse. */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Runs `python run_po.py <ocrChannel> <files...>` (local paths or s3:// URIs). The script writes nothing to disk and
 * prints nothing but the extracted PO as JSON on stdout, which is read here in memory (never logged).
 */
export const runOcr = (ocrChannel: string, files: string[], context: OcrRunContext = {}): Promise<OcrRun> =>
  new Promise((resolve) => {
    const started = Date.now();
    const script = path.resolve(env.ocr.script);
    const args = [script, ocrChannel, ...files];

    const out: Buffer[] = [];
    let outBytes = 0;
    let log = '';
    const append = (chunk: Buffer): void => {
      log = (log + chunk.toString('utf8')).slice(-LOG_TAIL_CHARS * 4);
    };

    // A path (e.g. .venv-ocr/Scripts/python.exe) is resolved from the project folder.
    const pythonBin = /[\\/]/.test(env.ocr.pythonBin) ? path.resolve(env.ocr.pythonBin) : env.ocr.pythonBin;
    const child = spawn(pythonBin, args, {
      // No __pycache__ inside the ocr-service submodule, so it stays clean for git pull / push.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true,
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_OUTPUT_BYTES) return;
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, env.ocr.timeoutMs);

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      const { result, stray } = parseOcrStdout(Buffer.concat(out).toString('utf8'));
      const durationMs = Date.now() - started;
      const report = result?.ocr_run as OcrRunReport | undefined;
      const facts = { op: 'run_po.py', ocrChannel, channel: context.channel, folder: context.folder, files: files.map((f) => path.basename(f)).join(', '), ms: durationMs, exitCode };
      const costFacts = ocrRunFacts(report);
      // OCR_COST (2026-11-05): one line per run, ok or not (a failed run may have paid model calls), to sum the spend
      // in CloudWatch by day / channel (LOGGING.md). A run with no report (killed, old script) logs costUsd unknown.
      writeLog('info', LOG_SOURCE.OCR, 'OCR_COST', `OCR run ${exitCode === 0 ? 'ok' : 'failed'}: $${typeof costFacts.costUsd === 'number' ? costFacts.costUsd.toFixed(4) : '?'} (${costFacts.modelCalls ?? '?'} model call(s), ${costFacts.textractPages ?? 0} Textract page(s))`, {
        ...facts, ok: exitCode === 0 && !result?.error, ...costFacts,
      });
      // OCR_TIMEOUT / OCR_NOT_INSTALLED / OCR_FAILED: the OCR's error with its type, AWS code, the stage it failed at,
      // the page decisions and the last lines of its own log; OCR_CALL / OCR_SLOW when ok.
      const ocrLog = report?.log?.slice(-FAILURE_LOG_LINES).join('\n');
      const failure = {
        ...facts, ...costFacts,
        error: typeof result?.error === 'string' ? result.error.slice(-1500) : undefined,
        errorType: result?.error_type, errorCode: result?.error_code,
        logTail: (ocrLog || stray || log || '(no output)').slice(-3000),
      };
      if (timedOut) logFailure(LOG_SOURCE.OCR, 'TIMEOUT', `OCR stopped after ${Math.round(durationMs / 1000)} s`, { ...failure, limitMs: env.ocr.timeoutMs });
      else if (exitCode === null) logFailure(LOG_SOURCE.OCR, 'NOT_INSTALLED', 'OCR could not start', { ...failure, pythonBin: env.ocr.pythonBin });
      else if (exitCode !== 0 || result?.error) {
        logFailure(LOG_SOURCE.OCR, 'FAILED', `OCR failed${report?.stage ? ` at "${report.stage}"` : ''}: ${typeof result?.error === 'string' ? result.error.slice(0, 300) : `exit code ${exitCode}, no readable output`}`, failure);
      } else if (env.log.extSlowMs > 0 && durationMs > Math.max(env.log.extSlowMs, env.ocr.timeoutMs / 2)) {
        writeLog('warn', LOG_SOURCE.OCR, 'OCR_SLOW', `OCR took ${Math.round(durationMs / 1000)} s (over half of OCR_TIMEOUT_MS)`, { ...facts, ...costFacts });
      } else writeLog('info', LOG_SOURCE.OCR, 'OCR_CALL', `OCR done in ${Math.round(durationMs / 1000)} s`, { ...facts, ...costFacts });
      resolve({ exitCode, result, timedOut, logTail: log.slice(-LOG_TAIL_CHARS), durationMs, ...(stray ? { stdoutTail: stray } : {}) });
    };

    child.on('error', (err) => {
      append(Buffer.from(`\n[extractPo] could not start ${env.ocr.pythonBin}: ${err.message}\n`));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
