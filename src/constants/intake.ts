/*
 * PO intake control per channel (user, 2026-10-23): Users & Roles -> Settings -> "PO intake". Each channel that comes
 * by email or API is switched ON / OFF and has a limit per day. Every channel starts OFF: after a deploy nothing is
 * processed until someone switches it on. A PO of a channel that is OFF, or over its limit today, is still received
 * and stored (files + S3) but HELD: no OCR, no processing. Switching the channel on processes its held POs one by
 * one, within today's limit; the rest go on the next day (the count resets every day, India time). Manual uploads are
 * never held (a person chose them).
 */
export const PO_INTAKE = {
  BASE: '/admin/po-intake',
  /** UNIVERSAL is registered before ONE, so "universal" is never read as a channel. */
  ROUTES: { LIST: '/', ONE: '/:channel', UNIVERSAL: '/universal' },
  BODY: { ENABLED: 'enabled', DAILY_LIMIT: 'dailyLimit', PROCESS_FROM: 'processFrom' },
  /** channel_intake_settings row holding the universal "process from" last applied to every channel. */
  UNIVERSAL_KEY: '*',
  /** An email whose body says this is a revised PO is never skipped as a duplicate before OCR. */
  REVISED_HINT: /revis/i,
  /** Highest limit per day that can be set (null = no limit). */
  MAX_DAILY_LIMIT: 10_000,
  /** How often held POs are looked at again (a new day frees the limit). */
  RELEASE_EVERY_MINUTES: 15,
  /** First look after the server starts. */
  RELEASE_FIRST_DELAY_MS: 90_000,
} as const;
