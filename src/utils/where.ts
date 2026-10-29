/*
 * Where an error came from in OUR code (2026-10-27), for the failedAt field of error lines: the first stack frame in
 * src/ (or dist/ on EC2), skipping node_modules and the logging helpers themselves, e.g.
 *   "modules/po-pipeline/po-save.service.ts:212 (applySave)"
 * Node's async stack traces keep our callers ("at async applySave (...)") even when the throw was inside a library.
 */

const SKIP = /[\\/](node_modules|node:)|[\\/]utils[\\/](where|logger|log-call|classify-error|AppError)\.[jt]s/;
const OURS = /[\\/](src|dist)[\\/](.+?\.[jt]s):(\d+):\d+/;

export const whereFailed = (err: unknown): string | undefined => {
  const stack = err instanceof Error ? err.stack : undefined;
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (SKIP.test(line)) continue;
    const m = OURS.exec(line);
    if (!m) continue;
    const fn = /at (?:async )?([^\s(]+) \(/.exec(line)?.[1];
    return `${m[2].replace(/\\/g, '/')}:${m[3]}${fn && fn !== 'Object.<anonymous>' ? ` (${fn})` : ''}`;
  }
  return undefined;
};
