import { CHANNELS } from './channels';
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

/**
 * "Revised" PO emails compared with the copy already in POST_FG before any OCR (backlog B7 part B, 2026-11-05;
 * po-pipeline/revised-check.ts): the same sheet -> not taken. Blinkit only (it re-sends POs as "revised" with nothing
 * changed in 64 of 69 copies on dev; every real change showed in its sheet).
 */
export const REVISED_CHECK = {
  CHANNELS: [CHANNELS.BLINKIT] as readonly string[],
} as const;

