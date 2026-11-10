import { CACHE_NS } from '../../constants/cache';
import { forgetCache } from '../cache/cache.service';

/*
 * The shared PO issues result (2026-10-29, user: "used by so many people ... do the optimization; nobody downloads stale
 * data"). The screen's answer for a window of days is computed once and shared by everyone for PO_ISSUES.CACHE_SECONDS;
 * forgetPoIssues() drops it at once when what it shows changes (a master add / edit / switch, a re-check, a review
 * decision); new POs show within CACHE_SECONDS. Downloads never use it (`fresh`).
 * 2026-11-10: kept in the shared cache (modules/cache: AWS ElastiCache when REDIS_URL is set, else server memory), so
 * every server shares it and a change on one server drops it on all.
 */

/** The data behind PO issues changed: the next screen load computes it again (on every server). */
export const forgetPoIssues = (): void => void forgetCache(CACHE_NS.PO_ISSUES);
