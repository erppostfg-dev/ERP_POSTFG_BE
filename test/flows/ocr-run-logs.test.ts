import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { parseOcrStdout, runOcr } from '../../src/modules/ocr/ocr-runner';

/*
 * OCR logs (2026-11-05, user: "write the logs for the OCR errors so we can debug easily", "how much one OCR run costs"):
 * the REAL runner (child process) against a stand-in for run_po.py (a small Node script printing what run_po.py
 * prints). Every run logs OCR_COST (tokens + USD, ok or failed); a failure logs OCR_FAILED with the OCR's error, its
 * type, the AWS code, the stage it failed at, the page decisions and the last lines of its own log; a stray line before
 * the JSON (the First Club failure: a background job printing late) no longer hides the result.
 */
let dir = '';
const saved = { bin: env.ocr.pythonBin, script: env.ocr.script, level: env.log.level, format: env.log.format };
const lines: Record<string, unknown>[] = [];

const report = (stage: string, cost: number, extra: Record<string, unknown> = {}) => ({
  stage,
  notes: {
    pages: [{ page: 1, chars: 3706, blank: false, usable: true, reason: 'digital text' }, { page: 2, chars: 0, blank: true, usable: true, reason: 'blank page (no text, no image): skipped' }],
    header_pages: [1], tables_source: 'TEXT', header_mode: 'TEXT, page(s) [1]',
  },
  calls: [{ label: 'Header fields | TEXT mode', model: 'qwen.qwen3-vl-235b-a22b', input_tokens: 4969, output_tokens: 733, cost_usd: cost }],
  totals: { model_calls: 1, input_tokens: 4969, output_tokens: 733, textract_pages: 0, model_cost_usd: cost, textract_cost_usd: 0, cost_usd: cost },
  duration_ms: 10852, log: ['[Text layer] 2 page(s)', '[Tables | TEXT] 1 table(s)', 'Calling the model'],
  ...extra,
});
/** A stand-in run_po.py: prints `stdout` and exits with `code`. */
const fakeOcr = async (stdout: string, code: number) => {
  const script = path.join(dir, `fake-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  // exit only once the write is done (a pipe is written asynchronously on Windows)
  await fs.writeFile(script, `process.stdout.write(${JSON.stringify(stdout)}, () => process.exit(${code}));`);
  env.ocr.script = script;
};
const logged = (code: string) => lines.filter((l) => l.code === code);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-logs-'));
  env.ocr.pythonBin = process.execPath; // node runs the stand-in
  env.log.level = 'info';
  env.log.format = 'json';
  const capture = (chunk: string | Uint8Array) => {
    for (const l of String(chunk).split('\n')) if (l.startsWith('{')) lines.push(JSON.parse(l) as Record<string, unknown>);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});
afterEach(() => { lines.length = 0; });
afterAll(async () => {
  vi.restoreAllMocks();
  Object.assign(env.ocr, { pythonBin: saved.bin, script: saved.script });
  Object.assign(env.log, { level: saved.level, format: saved.format });
  await fs.rm(dir, { recursive: true, force: true });
});

describe('OCR run logs', () => {
  it('a run that worked: OCR_COST with pages, path, tokens and USD; OCR_CALL; the result read', async () => {
    await fakeOcr(JSON.stringify({ channel: 'first_club', header: { 'PO Number': 'PO-1' }, line_items: [], ocr_run: report('done', 0.008357) }), 0);
    const run = await runOcr('first_club', ['s3://b/manual-upload/x/PO-210392.pdf'], { folder: '2026-11-05_70', channel: 'first_club' });
    expect(run.result?.header).toEqual({ 'PO Number': 'PO-1' });
    expect(logged('OCR_COST')).toEqual([expect.objectContaining({
      ok: true, channel: 'first_club', folder: '2026-11-05_70', files: 'PO-210392.pdf', stage: 'done', pages: 2, blankPages: '2', headerPages: '1',
      tablesSource: 'TEXT', model: 'qwen.qwen3-vl-235b-a22b', modelCalls: 1, modelIn: 4969, modelOut: 733, textractPages: 0, costUsd: 0.008357,
    })]);
    expect(logged('OCR_CALL')).toHaveLength(1);
    expect(logged('OCR_FAILED')).toEqual([]);
  });

  it('a failure: OCR_FAILED with the error, type, AWS code, stage, cost already spent and the OCR\'s own last lines; a stray line before the JSON does not hide it', async () => {
    const out = { channel: 'first_club', error: 'InvalidS3ObjectException - Unable to get object metadata from S3', error_type: 'PipelineError', error_code: 'InvalidS3ObjectException',
      ocr_run: report('tables (+ header in parallel)', 0.0141, { log: ['[Tables | TEXTRACT] using Textract: page 2: probably a scanned page', 'starting AnalyzeDocument job'] }) };
    await fakeOcr(`  [Header fields | VISION mode] tokens 19041 in / 733 out\n${JSON.stringify(out)}\n`, 1);
    const run = await runOcr('first_club', ['s3://b/PO-210392.pdf'], { folder: '2026-11-05_70', channel: 'first_club' });
    expect(run.result?.error_code).toBe('InvalidS3ObjectException');
    expect(run.stdoutTail).toContain('VISION mode');
    const [f] = logged('OCR_FAILED');
    expect(f).toMatchObject({ errorType: 'PipelineError', errorCode: 'InvalidS3ObjectException', stage: 'tables (+ header in parallel)', costUsd: 0.0141, folder: '2026-11-05_70' });
    expect(String(f.msg)).toContain('tables (+ header in parallel)');
    expect(String(f.error)).toContain('Unable to get object metadata');
    expect(String(f.logTail)).toContain('using Textract');
    expect(logged('OCR_COST')).toEqual([expect.objectContaining({ ok: false, costUsd: 0.0141 })]);
  });

  it('no JSON at all: OCR_FAILED says so and keeps what was printed; cost unknown', async () => {
    await fakeOcr('Traceback (most recent call last):\n  boom\n', 1);
    const run = await runOcr('first_club', ['PO.pdf']);
    expect(run.result).toBeUndefined();
    expect(run.stdoutTail).toContain('boom');
    const [f] = logged('OCR_FAILED');
    expect(String(f.msg)).toContain('no readable output');
    expect(String(f.logTail)).toContain('boom');
    expect(logged('OCR_COST')[0]).toMatchObject({ ok: false });
    expect(logged('OCR_COST')[0].costUsd).toBeUndefined();
  });

  it('parseOcrStdout: the whole output, else the last JSON line (rest kept), else nothing', () => {
    expect(parseOcrStdout('{"a":1}')).toEqual({ result: { a: 1 } });
    expect(parseOcrStdout('late line\n{"a":2}\n')).toEqual({ result: { a: 2 }, stray: 'late line' });
    expect(parseOcrStdout('garbage')).toEqual({ stray: 'garbage' });
    expect(parseOcrStdout('  ')).toEqual({});
  });
});
