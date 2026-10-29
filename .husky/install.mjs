// Installs the git hooks (husky) on `npm install`; skipped where they make no sense (Docker build, CI, production
// install without dev packages) so `npm ci` never fails there.
if (process.env.CI === 'true' || process.env.NODE_ENV === 'production' || process.env.HUSKY === '0') process.exit(0);
try {
  const husky = (await import('husky')).default;
  const msg = husky();
  if (msg) console.log(msg);
} catch {
  // husky is a dev package: not installed with --omit=dev
}
