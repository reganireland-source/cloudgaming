/**
 * ============================================================================
 * src/services/RocjobFiles.ts: THE ROCJOB GAME DOWNLOADS, SERVED BY GGGH
 * ============================================================================
 *
 * The Windows and Mac zips live in a folder on the backend's disk and are
 * served from /api/rocjob/get/windows and /api/rocjob/get/mac (the site's
 * /rocjob/get/... short links redirect there), so the page never shows a
 * Google Drive link.
 *
 * The folder must be on a Railway VOLUME or an upload disappears at the next
 * deploy: add a Volume to the backend service, mount it at /data, and (if you
 * mount it somewhere else) set ROCJOB_FILES_DIR to that path.
 *
 * Settings (environment variables):
 *   ROCJOB_FILES_DIR       where the zips are kept (default /data/rocjob)
 *   ROCJOB_MAX_UPLOAD_MB   largest upload accepted (default 2048)
 * Uploading uses the same secret as the stats page (ROCJOB_STATS_TOKEN).
 * ============================================================================
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

export const PLATFORMS = ['windows', 'mac'] as const;
export type FilePlatform = typeof PLATFORMS[number];
export const isPlatform = (v: unknown): v is FilePlatform => PLATFORMS.includes(v as FilePlatform);

const dir = () => process.env.ROCJOB_FILES_DIR || '/data/rocjob';
const maxBytes = () => Math.max(1, Number(process.env.ROCJOB_MAX_UPLOAD_MB) || 2048) * 1024 * 1024;
export const zipPath = (p: FilePlatform) => path.join(dir(), `${p}.zip`);
const metaPath = (p: FilePlatform) => path.join(dir(), `${p}.json`);

export interface FileMeta { platform: FilePlatform; name: string; size: number; sha256: string; uploadedAt: string }

export function readMeta(p: FilePlatform): FileMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(p), 'utf8'));
    const st = fs.statSync(zipPath(p));
    return { platform: p, name: String(m.name), size: st.size, sha256: String(m.sha256), uploadedAt: String(m.uploadedAt) };
  } catch { return null; }
}

/** A safe download name: letters, digits, dot, dash, underscore, space; ends .zip. */
export function cleanName(v: unknown, p: FilePlatform): string {
  const s = typeof v === 'string' ? v.replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 80) : '';
  if (!s) return `Rocjob-${p}.zip`;
  return /\.zip$/i.test(s) ? s : `${s}.zip`;
}

/** Streams the request body to disk (never held in memory), then swaps it in. */
export function saveUpload(req: Request, p: FilePlatform, name: string): Promise<FileMeta> {
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(dir(), { recursive: true }); } catch (e) { return reject(new Error(`The downloads folder ${dir()} can't be created: ${(e as Error).message}`)); }
    const tmp = path.join(dir(), `${p}.upload`);
    const out = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    let bytes = 0, failed = false;
    const fail = (err: Error) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => reject(err)); };
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > maxBytes()) { req.unpipe(out); req.resume(); fail(new Error(`That is over the ${Math.round(maxBytes() / 1048576)} MB limit.`)); return; }
      hash.update(c);
    });
    req.on('aborted', () => fail(new Error('The upload was interrupted.')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (bytes === 0) return fail(new Error('The upload was empty.'));
      const meta = { name, sha256: hash.digest('hex'), uploadedAt: new Date().toISOString() };
      try {
        fs.renameSync(tmp, zipPath(p));
        fs.writeFileSync(metaPath(p), JSON.stringify(meta));
      } catch (e) { return fail(e as Error); }
      resolve({ platform: p, name, size: bytes, sha256: meta.sha256, uploadedAt: meta.uploadedAt });
    });
    req.pipe(out);
  });
}

export function removeFile(p: FilePlatform) {
  fs.rmSync(zipPath(p), { force: true });
  fs.rmSync(metaPath(p), { force: true });
}

export function folderInfo() {
  let writable = false;
  try { fs.mkdirSync(dir(), { recursive: true }); fs.accessSync(dir(), fs.constants.W_OK); writable = true; } catch { /* reported below */ }
  return { dir: dir(), writable, maxUploadMb: Math.round(maxBytes() / 1048576) };
}
