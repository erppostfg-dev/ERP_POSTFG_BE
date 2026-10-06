import fs from 'fs/promises';
import path from 'path';
import { env } from '../../../config/env';
import { plannedS3Folder, EmailMetadata } from '../../email-intake/s3-layout';
import { syncEmailToS3 } from '../../email-intake/s3-mirror.service';
import { ProcessedPo } from './processed-po';

export const PROCESSED_FILE = 'processed.json';

/** s3:// URL of a file in the PO's S3 folder (the folder kept in metadata.json, or the planned one). */
export const s3UrlFor = (folder: string, meta: EmailMetadata, fileName: string): string =>
  `s3://${env.s3.bucket}/${meta.s3Folder ?? plannedS3Folder(folder, meta)}/${fileName}`;

/**
 * Writes processed.json into the PO folder, then uploads the folder to its S3 folder
 * (po-intake/FY.../<month>/<channel>/<PO>/processed.json). Returns the S3 folder ("" when S3 is off).
 */
export const saveProcessed = async (folder: string, po: ProcessedPo): Promise<string> => {
  const file = path.join(folder, PROCESSED_FILE);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(po, null, 2), 'utf8');
  await fs.rename(`${file}.tmp`, file);
  return (await syncEmailToS3(folder)).s3Folder;
};
