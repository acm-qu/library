// The one access rule. Every media route, asset read and HLS key request asks `access()` and compares the
// result with the route's minimum; anything below is 404, never 403 (members never learn core items exist).
import type { Asset } from '@acm/core/db';
import type { Viewer } from '@acm/core/schemas';

export const LEVELS = ['none', 'status', 'download', 'full'] as const;
export type Access = (typeof LEVELS)[number];

export type AssetForAccess = Pick<Asset, 'tier' | 'girlsOnly' | 'status' | 'uploaderId' | 'deletedAt'>;

/** Girls-only items are for signed-in female core members only: not male admins, not their own male uploader. */
export const seesGirlsOnly = (v: Viewer) => v.role === 'core' && v.isFemale === true;

export function access(v: Viewer | null, a: AssetForAccess, eventDeleted = false): Access {
  if (!v || v.status !== 'active') return 'none';
  if (a.deletedAt || eventDeleted || a.status === 'deleting') return 'none';
  if (a.tier === 'core' && v.role !== 'core') return 'none';
  if (a.girlsOnly && !seesGirlsOnly(v)) return 'none';
  if (a.status === 'ready') return 'full';
  if (a.status === 'original_only') return 'download';
  return v.isAdmin || a.uploaderId === v.id ? 'status' : 'none';
}

/** Route guard: anything below `min` becomes a 404. */
export const atLeast = (have: Access, min: Access) => LEVELS.indexOf(have) >= LEVELS.indexOf(min);

/** Whether the viewer may change this asset's tier or move it (own upload for core, any for admin). */
export const canEditAsset = (v: Viewer, a: AssetForAccess) =>
  access(v, a) !== 'none' && (v.isAdmin || (v.role === 'core' && a.uploaderId === v.id));
