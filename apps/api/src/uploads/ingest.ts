// onUploadFinish: sniff, probe, move into the asset directory, then asset → queued plus a process job, in one
// transaction. Bounded work only: no full read of the file inside the request (hashing is the worker's first step).
import { mkdir, rename, rm } from 'node:fs/promises';
import { assets, type Db, jobs } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { assetDir, originalPath } from '@acm/core/paths';
import { and, eq } from 'drizzle-orm';
import { probeImage, probeVideo } from './probe.ts';
import { sniffFile } from './sniff.ts';

export const IMAGE_PRIORITY = 100; // photos are ready in seconds; never stuck behind a long video
export const VIDEO_PRIORITY = 0;

export class UnsupportedType extends Error {}

export async function ingest(db: Db, opts: { mediaRoot: string; ffprobe: string }, uploadId: string, file: string) {
  const [a] = await db.select().from(assets).where(and(eq(assets.uploadId, uploadId), eq(assets.status, 'uploading')));
  if (!a) throw new Error(`no uploading asset for ${uploadId}`);
  const type = await sniffFile(file);
  if (!type) {
    await db.delete(assets).where(eq(assets.id, a.id));
    await rm(file, { force: true });
    await rm(`${file}.json`, { force: true });
    throw new UnsupportedType(a.originalFilename);
  }
  const probe = type.kind === 'image' ? await probeImage(file) : await probeVideo(opts.ffprobe, file);
  await mkdir(assetDir(opts.mediaRoot, a.id), { recursive: true, mode: 0o750 });
  const dest = originalPath(opts.mediaRoot, a.id, type.ext, false);
  await rename(file, dest);
  await db.transaction(async (tx) => {
    await tx
      .update(assets)
      .set({ status: 'queued', kind: type.kind, originalMime: type.mime, originalExt: type.ext, ...probe, updatedAt: new Date() })
      .where(eq(assets.id, a.id));
    await tx.insert(jobs).values({ id: newId(), assetId: a.id, kind: 'process', priority: type.kind === 'image' ? IMAGE_PRIORITY : VIDEO_PRIORITY });
  });
  await rm(`${file}.json`, { force: true });
  return { id: a.id, kind: type.kind };
}
