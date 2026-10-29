// On-disk layout under MEDIA_ROOT, shared by the API (ingest, serving) and the worker (outputs, purge).
//   tus/<uploadId>(.json)          in-flight uploads
//   assets/<shard>/<id>/original.<ext>[.enc]
//   assets/<shard>/<id>/r<rev>/... renditions of one processing revision
//   assets/<shard>/<id>/r<rev>/frames/<n>.webp[.enc]  frames sampled for tone-curve scoring (HDR video, auto)
//   tmp/<jobId>/                   worker scratch, removed after each job
import path from 'node:path';

/** Two hex characters from the random tail of the UUID v7 (the head is a timestamp and would cluster). */
export const shard = (id: string) => id.slice(-2);

export const assetDir = (mediaRoot: string, id: string) => path.join(mediaRoot, 'assets', shard(id), id);
export const originalPath = (mediaRoot: string, id: string, ext: string, encrypted: boolean) =>
  path.join(assetDir(mediaRoot, id), `original.${ext}${encrypted ? '.enc' : ''}`);
export const revDir = (mediaRoot: string, id: string, rev: number) => path.join(assetDir(mediaRoot, id), `r${rev}`);
export const tusDir = (mediaRoot: string) => path.join(mediaRoot, 'tus');
export const tmpDir = (mediaRoot: string, jobId: string) => path.join(mediaRoot, 'tmp', jobId);

/** One tone-curve table under LUTS_DIR, as written by `python -m mediaworker luts`. */
export const lutPath = (lutsDir: string, curve: string, transfer: 'hlg' | 'pq') => path.join(lutsDir, `${curve}.${transfer}.cube`);
/** Written by the tone-curve validation gate; tonemap_auto can only be switched on while it exists. */
export const tonemapGatePath = (lutsDir: string) => path.join(lutsDir, 'gate-passed.json');
