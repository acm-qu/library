// Asset status helpers shared by the API and the worker. Labels live in the web app's i18n catalogue.
import type { AssetStatus } from './enums.ts';

/** Statuses the UI keeps polling for (My uploads, shell processing indicator). */
export const UNFINISHED: readonly AssetStatus[] = ['uploading', 'queued', 'processing'];
/** Statuses that need someone to act. */
export const ATTENTION: readonly AssetStatus[] = ['failed', 'needs_review'];
/** Statuses whose media bytes may be served (thumb/view/HLS need 'ready'; original also allows 'original_only'). */
export const SERVABLE: readonly AssetStatus[] = ['ready', 'original_only'];

export const isUnfinished = (s: AssetStatus): boolean => UNFINISHED.includes(s);
export const isServable = (s: AssetStatus): boolean => SERVABLE.includes(s);

/** Legal status transitions (see the asset lifecycle diagram). `ready → ready` is a re-process swap. */
const TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  uploading: ['queued'],
  queued: ['processing', 'deleting'],
  processing: ['ready', 'needs_review', 'queued', 'failed'],
  ready: ['ready', 'deleting'],
  failed: ['queued', 'deleting'],
  needs_review: ['queued', 'original_only', 'deleting'],
  original_only: ['deleting'],
  deleting: [],
};

export const canTransition = (from: AssetStatus, to: AssetStatus): boolean => TRANSITIONS[from].includes(to);
