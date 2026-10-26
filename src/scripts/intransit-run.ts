/*
 * Build the in-transit stock report by hand (no server, no database).
 *
 *   npm run intransit:run -- --input-dir <folder with the 19 CSVs> [--template <xlsx>] [--as-of YYYY-MM-DD]
 *                            [--from-date YYYY-MM-DD | <days>] [--out <folder>]
 *
 * Defaults: the inputs of the as-of day as the server uses them (masters + that day's files, or the latest earlier
 * copy; copied to <out>/input), the template in the input folder, today (IST), INTRANSIT_FROM_DATE (none when blank),
 * output storage/intransit/manual.
 */
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { INTRANSIT_TEMPLATE_NAME } from '../constants';
import { resolveFromDate } from '../modules/intransit/context';
import { checkDate, resolveInputs } from '../modules/intransit/input-store';
import { runPipeline } from '../modules/intransit/pipeline';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const asOf = checkDate(arg('as-of'));
  const outputDir = path.resolve(arg('out') ?? 'storage/intransit/manual');
  let inputDir = arg('input-dir') ? path.resolve(arg('input-dir') as string) : '';
  if (!inputDir) {
    inputDir = path.join(outputDir, 'input');
    const { files, missing } = await resolveInputs(asOf);
    if (missing.length) throw new Error(`no copy of ${missing.join(', ')} for ${asOf}`);
    await fs.mkdir(inputDir, { recursive: true });
    for (const file of files) await fs.copyFile(file.path, path.join(inputDir, file.name));
    const earlier = files.filter((x) => x.from === 'earlier');
    console.log(`inputs of ${asOf}${earlier.length ? ` (earlier copies: ${earlier.map((x) => `${x.name} ${x.date}`).join(', ')})` : ''}`);
  }
  const { result } = await runPipeline({
    inputDir,
    templateXlsx: path.resolve(arg('template') ?? path.join(inputDir, INTRANSIT_TEMPLATE_NAME)),
    outputDir,
    asOf,
    fromDate: resolveFromDate(arg('from-date') ?? env.intransit.fromDate, asOf),
  });
  console.table(result.summary);
  console.log('timings (s):', result.timings);
  console.log(`report: ${result.reportPath}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
