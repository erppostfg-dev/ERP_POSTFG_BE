import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { ERROR_CODES } from '../../../constants';
import { appError } from '../../../utils/AppError';

/*
 * Who reads and writes which part of the in-transit store in S3 (user, 2026-10-26):
 *   - the live server writes 'prod' = inventory/;
 *   - a test machine (INTRANSIT_TEST, see env.ts) writes only 'test' = inventory-test/ (one folder shared by all test
 *     machines) and reads inventory/ too - the test copy of a day's file wins there;
 *   - a machine without INTRANSIT_S3_ENABLED or without the database keeps the disk store (INTRANSIT_DIR).
 */

export const PROD_SCOPE = 'prod';
export const TEST_SCOPE = 'test';
export type Scope = typeof PROD_SCOPE | typeof TEST_SCOPE;

const ROOTS: Record<Scope, string> = { prod: 'inventory/', test: 'inventory-test/' };

/** The scope this machine writes. */
export const writeScope = (): Scope => (env.intransit.test ? TEST_SCOPE : PROD_SCOPE);

/** The scopes this machine reads, its own first (its own copy wins). */
export const visibleScopes = (): Scope[] => (writeScope() === PROD_SCOPE ? [PROD_SCOPE] : [TEST_SCOPE, PROD_SCOPE]);

/** The key prefix of a scope. */
export const rootOf = (scope: Scope): string => ROOTS[scope];

/** The scope a key is in, or null when it is outside the in-transit store. */
export const scopeOfKey = (key: string): Scope | null =>
  key.startsWith(ROOTS.test) ? TEST_SCOPE : key.startsWith(ROOTS.prod) ? PROD_SCOPE : null;

/** Throws unless this machine may write `key` (a test machine can never write inventory/). */
export const assertWritable = (key: string): void => {
  const scope = scopeOfKey(key);
  if (scope !== writeScope()) throw appError(ERROR_CODES.INTRANSIT_SCOPE_READ_ONLY, key, rootOf(writeScope()));
};

/** True when `key` is in a scope this machine may read. */
export const isVisibleKey = (key: string): boolean => {
  const scope = scopeOfKey(key);
  return !!scope && visibleScopes().includes(scope);
};

/** Why the S3 store cannot be used on this machine (empty = it can). */
export const storageProblems = (): string[] => [
  ...(env.intransit.s3Enabled ? [] : ['INTRANSIT_S3_ENABLED']),
  ...(AppDataSource.isInitialized ? [] : ['the database (DB_ENABLED)']),
];

/**
 * Files go to S3 (and are read from it) on this machine. Until the old disk store is moved (plan phase S5), a machine
 * without it keeps working from its disk as before.
 */
export const storageOn = (): boolean => storageProblems().length === 0;

/** 503 "S3 storage is not set up on this computer" unless it is. */
export const assertStorageSetUp = (): void => {
  const missing = storageProblems();
  if (missing.length) throw appError(ERROR_CODES.INTRANSIT_STORAGE_NOT_SET_UP, missing.join(', ')).withDetails({ missing });
};
