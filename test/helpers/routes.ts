import type { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { ROOT } from '../setup/load-env';

/*
 * Every endpoint of the app, read from the real Express routers (2026-10-28), as "METHOD /path" without the
 * /api/v1 prefix, e.g. "PATCH /masters/edit/:type/:id".
 * covers([...]) marks which endpoints a test file tests; test/meta/routes.test.ts checks that every endpoint is covered
 * (or still listed in test/meta/untested.json while the suite is being built).
 */
type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
  name?: string;
};

const mountPath = (layer: Layer): string => {
  const src = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)' || src === '^\\/?$') return '';
  return src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
};

const walk = (stack: Layer[], prefix: string, out: Set<string>) => {
  for (const layer of stack) {
    if (layer.route) {
      for (const [m, on] of Object.entries(layer.route.methods)) if (on && m !== '_all') out.add(`${m.toUpperCase()} ${(prefix + layer.route.path).replace(/\/+$/, '') || '/'}`);
    } else if (layer.handle?.stack) walk(layer.handle.stack, prefix + mountPath(layer), out);
  }
};

export const listRoutes = (router: Router): string[] => {
  const out = new Set<string>();
  walk((router as unknown as { stack: Layer[] }).stack, '', out);
  return [...out].sort();
};

/** Marks the endpoints a test file covers (read by test/meta/routes.test.ts from the file text). */
export const covers = (_endpoints: string[]): void => undefined;

/** Endpoints named in covers([...]) of every test file under test/. */
export const coveredEndpoints = (): Set<string> => {
  const found = new Set<string>();
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.test.ts')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/covers\(\s*\[([\s\S]*?)\]\s*\)/g)) {
          for (const s of m[1].matchAll(/'([A-Z]+ [^']+)'/g)) found.add(s[1]);
        }
      }
    }
  };
  visit(path.join(ROOT, 'test'));
  return found;
};
