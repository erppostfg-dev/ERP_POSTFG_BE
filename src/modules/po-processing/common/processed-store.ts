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
  await writeJson(path.join(folder, PROCESSED_FILE), po);
  return (await syncEmailToS3(folder)).s3Folder;
};

/** Sub-folder of an email folder that holds one folder per PO, for emails with several POs (Purplle). */
export const POS_DIR = 'POs';

/**
 * For an email that holds several POs (Purplle's daily summary): writes <email folder>/POs/<PO number>/processed.json
 * for each PO, then uploads the email folder (with POs/) to its S3 folder. Returns the S3 folder ("" when S3 is off).
 */
export const saveProcessedMany = async (folder: string, pos: ProcessedPo[]): Promise<string> => {
  for (const po of pos) {
    const dir = path.join(folder, POS_DIR, po.po_number || 'no-po-number');
    await fs.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, PROCESSED_FILE), po);
  }
  return (await syncEmailToS3(folder)).s3Folder;
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(`${file}.tmp`, file);
};
