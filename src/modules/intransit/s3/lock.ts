import { createHash } from 'crypto';
import { AppDataSource } from '../../../config/data-source';
import { ERROR_CODES } from '../../../constants';
import { appError } from '../../../utils/AppError';

/**
 * Run `job` holding the MySQL lock `name` on its own connection (machines share the database): waits up to `waitS`
 * seconds, then 409. Names longer than MySQL's 64 characters are hashed.
 */
export const withLock = async <T>(name: string, job: () => Promise<T>, waitS = 30): Promise<T> => {
  const lock = name.length <= 64 ? name : `it:${createHash('sha1').update(name).digest('hex')}`;
  const qr = AppDataSource.createQueryRunner();
  await qr.connect();
  try {
    const [got] = (await qr.query('SELECT GET_LOCK(?, ?) AS got', [lock, waitS])) as { got: number | string | null }[];
    if (Number(got?.got) !== 1) throw appError(ERROR_CODES.INTRANSIT_BUSY, name);
    try {
      return await job();
    } finally {
      await qr.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => undefined);
    }
  } finally {
    await qr.release();
  }
};
