import { spawn } from 'child_process';
import path from 'path';
import { env } from '../../config/env';

export interface OcrRun {
  /** run_po.py exit code: 0 ok, 1 pipeline error, 2 bad arguments; null if it was killed or did not start. */
  exitCode: number | null;
  /** The RESULT: {...} JSON printed by run_po.py, if any. */
  result?: Record<string, unknown>;
  timedOut: boolean;
  /** Last part of the console output, for debugging. */
  logTail: string;
  durationMs: number;
}

const LOG_TAIL_CHARS = 8000;

/**
 * Runs `python run_po.py <ocrChannel> <files...> --output <outputName>` with the working folder
 * set to `workDir`, so the output CSV and <output>_result.json land there.
 */
export const runOcr = (ocrChannel: string, files: string[], workDir: string, outputName: string): Promise<OcrRun> =>
  new Promise((resolve) => {
    const started = Date.now();
    const script = path.resolve(env.ocr.script);
    const args = [script, ocrChannel, ...files, '--output', outputName];

    let log = '';
    const append = (chunk: Buffer): void => {
      log = (log + chunk.toString('utf8')).slice(-LOG_TAIL_CHARS * 4);
    };

    // A path (e.g. .venv-ocr/Scripts/python.exe) is resolved from the project folder, not the email folder.
    const pythonBin = /[\\/]/.test(env.ocr.pythonBin) ? path.resolve(env.ocr.pythonBin) : env.ocr.pythonBin;
    const child = spawn(pythonBin, args, {
      cwd: workDir,
      // No __pycache__ inside the ocr-service submodule, so it stays clean for git pull / push.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true,
    });
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, env.ocr.timeoutMs);

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      const line = log
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.startsWith('RESULT: '));
      let result: Record<string, unknown> | undefined;
      if (line) {
        try {
          result = JSON.parse(line.slice('RESULT: '.length)) as Record<string, unknown>;
        } catch {
          // leave result empty; the log tail shows what happened
        }
      }
      resolve({ exitCode, result, timedOut, logTail: log.slice(-LOG_TAIL_CHARS), durationMs: Date.now() - started });
    };

    child.on('error', (err) => {
      append(Buffer.from(`\n[extractPo] could not start ${env.ocr.pythonBin}: ${err.message}\n`));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
