// Row → response shapes. Media URLs carry ?v=rendition_rev so caches can be immutable.
import type { Asset } from '@acm/core/db';
import type { AssetTile, Viewer } from '@acm/core/schemas';
import { access, atLeast } from '../policy/canView.ts';
import type { ActiveJob } from './queue.ts';

export const mediaUrl = (id: string, what: string, rev: number) => `/api/media/${id}/${what}?v=${rev}`;

export function thumbUrl(a: Pick<Asset, 'id' | 'status' | 'renditionRev'>) {
  return a.status === 'ready' ? mediaUrl(a.id, 'thumb', a.renditionRev) : null;
}

export function toTile(v: Viewer, a: Asset, job: ActiveJob | undefined): AssetTile {
  const level = access(v, a);
  const showsProgress = v.isAdmin || a.uploaderId === v.id;
  return {
    id: a.id,
    kind: a.kind,
    tier: a.tier,
    girlsOnly: a.girlsOnly,
    status: a.status,
    width: a.width,
    height: a.height,
    durationS: a.durationS,
    hdr: a.hdr,
    thumbUrl: atLeast(level, 'full') ? thumbUrl(a) : null,
    processing: a.status === 'ready' && !!job && showsProgress,
    step: showsProgress ? (job?.step ?? null) : null,
    progress: showsProgress ? (job?.progress ?? null) : null,
    readyInS: showsProgress && job ? job.readyInS : null,
  };
}

/** "IMG_4515.MOV" stays as uploaded; anything unsafe for a header is replaced. */
export const downloadName = (a: Pick<Asset, 'originalFilename' | 'originalExt'>) =>
  a.originalFilename.replace(/[\u0000-\u001f\u007f/\\"]/g, '_') || `original.${a.originalExt}`;
