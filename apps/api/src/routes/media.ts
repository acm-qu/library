// Media bytes. Every route resolves access() first; anything the viewer may not reach is a 404.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '@acm/core/config';
import { type Asset, assetKeys, type Db, type RenditionKind, renditions } from '@acm/core/db';
import { openRange, parseMasterKey, readHeader, unwrapKey } from '@acm/core/crypto';
import { admit, servedAs } from '../media/throttle.ts';
import { Readable } from 'node:stream';
import { assetDir, originalPath } from '@acm/core/paths';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readerOf } from '../auth/plugin.ts';
import { notFound } from '../lib/errors.ts';
import { attachment, parseRange } from '../media/range.ts';
import { loadAsset } from './assets.ts';

const IMMUTABLE = 'private, max-age=31536000, immutable';

const KINDS: Record<string, { kinds: RenditionKind[]; min: 'full' | 'download'; type: string }> = {
  thumb: { kinds: ['image_thumb', 'video_thumb'], min: 'full', type: 'image/webp' },
  view: { kinds: ['image_view'], min: 'full', type: 'image/webp' },
  poster: { kinds: ['video_poster'], min: 'full', type: 'image/webp' },
};

/** Stream a plaintext file with Range support. */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, type: string, headers: Record<string, string>) {
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) throw notFound();
  if (req.method !== 'HEAD') admit(st.size);
  reply.headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...headers });
  const span = parseRange(req.headers.range, st.size);
  if (span === 'unsatisfiable') return reply.code(416).header('Content-Range', `bytes */${st.size}`).send();
  if (span) {
    reply.code(206).header('Content-Range', `bytes ${span.start}-${span.end}/${st.size}`).header('Content-Length', String(span.end - span.start + 1));
    return reply.send(req.method === 'HEAD' ? '' : servedAs(createReadStream(file, { start: span.start, end: span.end }), st.size));
  }
  reply.header('Content-Length', String(st.size));
  return reply.send(req.method === 'HEAD' ? '' : servedAs(createReadStream(file), st.size));
}

/** Stream a sealed (ACMENC01) file, decrypting only the chunks the requested range overlaps. */
export async function sendSealed(req: FastifyRequest, reply: FastifyReply, file: string, key: Buffer, assetId: string, type: string, headers: Record<string, string>) {
  const h = await readHeader(file).catch(() => {
    throw notFound();
  });
  const size = h.plaintextSize;
  if (req.method !== 'HEAD') admit(size);
  reply.headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...headers });
  const span = parseRange(req.headers.range, size);
  if (span === 'unsatisfiable') return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  const start = span ? span.start : 0;
  const end = span ? span.end : size - 1;
  if (span) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
  reply.header('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (req.method === 'HEAD' || size === 0) return reply.send('');
  // An authentication failure mid-stream destroys the response: the client sees a broken download, never bad bytes.
  const stream = Readable.from(openRange(file, key, assetId, start, end), { highWaterMark: 1 });
  stream.on('error', (err) => req.log.error({ err, assetId }, 'sealed file failed authentication'));
  return reply.send(servedAs(stream, size));
}

export function mediaRoutes(app: FastifyInstance, { db, cfg }: { db: Db; cfg: ServerConfig }) {
  const params = z.object({ id: z.string(), what: z.string() });
  const master = parseMasterKey(cfg.MASTER_KEY);
  async function keysOf(assetId: string) {
    const [row] = await db.select().from(assetKeys).where(eq(assetKeys.assetId, assetId));
    if (!row) throw notFound();
    return { fileKey: unwrapKey(row.fileKeyWrapped, master), hlsKey: row.hlsKeyWrapped ? unwrapKey(row.hlsKeyWrapped, master) : null };
  }

  app.get('/api/media/:id/original', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const a: Asset = await loadAsset(db, readerOf(req), id, 'download');
    const headers = { 'Content-Disposition': attachment(a.originalFilename), 'Cache-Control': 'private, no-cache' };
    const type = a.originalMime ?? 'application/octet-stream';
    if (a.encrypted) {
      const { fileKey } = await keysOf(a.id);
      return sendSealed(req, reply, originalPath(cfg.MEDIA_ROOT, a.id, a.originalExt, true), fileKey, a.id, type, headers);
    }
    return sendFile(req, reply, originalPath(cfg.MEDIA_ROOT, a.id, a.originalExt, false), type, headers);
  });

  // HLS. Playlists stay as ffmpeg wrote them except that every URI gets ?v=<rendition_rev>, so data.ts can be
  // cached as immutable and a re-process never mixes old byte ranges with a new playlist.
  const withRev = (text: string, rev: number) => text.replace(/^(?!#)(\S+)$/gm, (uri) => `${uri}${uri.includes('?') ? '&' : '?'}v=${rev}`);

  /** The AES-128 key for a core video's segments. Same 404 rule as the media; never cached. */
  app.get('/api/media/:id/hls/key', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const a = await loadAsset(db, readerOf(req), id, 'full');
    if (a.tier !== 'core' || a.kind !== 'video') throw notFound();
    const { hlsKey } = await keysOf(a.id);
    if (!hlsKey) throw notFound();
    return reply.headers({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(hlsKey);
  });

  app.get('/api/media/:id/hls/master.m3u8', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const a = await loadAsset(db, readerOf(req), id, 'full');
    const [m] = await db.select().from(renditions).where(and(eq(renditions.assetId, a.id), eq(renditions.kind, 'hls_master')));
    if (!m) throw notFound();
    const text = await readFile(path.join(assetDir(cfg.MEDIA_ROOT, a.id), m.relPath), 'utf8').catch(() => {
      throw notFound();
    });
    return reply.headers({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-cache' }).send(withRev(text, a.renditionRev));
  });

  async function variant(req: FastifyRequest) {
    const p = z.object({ id: z.string(), variant: z.string().regex(/^\d{3,4}p$/) }).safeParse(req.params);
    if (!p.success) throw notFound();
    const { id, variant: label } = p.data;
    const a = await loadAsset(db, readerOf(req), id, 'full');
    // Only stored labels are accepted; nothing from the URL is joined into a path.
    const [r] = await db.select().from(renditions).where(and(eq(renditions.assetId, a.id), eq(renditions.kind, 'hls_variant'), eq(renditions.label, label)));
    if (!r) throw notFound();
    return { a, dir: path.dirname(path.join(assetDir(cfg.MEDIA_ROOT, a.id), r.relPath)) };
  }

  app.get('/api/media/:id/hls/:variant/index.m3u8', async (req, reply) => {
    const { a, dir } = await variant(req);
    const text = await readFile(path.join(dir, 'index.m3u8'), 'utf8').catch(() => {
      throw notFound();
    });
    return reply.headers({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-cache' }).send(withRev(text, a.renditionRev));
  });

  app.get('/api/media/:id/hls/:variant/data.ts', async (req, reply) => {
    const { dir } = await variant(req);
    return sendFile(req, reply, path.join(dir, 'data.ts'), 'video/mp2t', { 'Cache-Control': IMMUTABLE });
  });

  app.get('/api/media/:id/:what', async (req, reply) => {
    const { id, what } = params.parse(req.params);
    const spec = Object.hasOwn(KINDS, what) ? KINDS[what] : undefined;
    if (!spec) throw notFound();
    const a = await loadAsset(db, readerOf(req), id, spec.min);
    const [r] = await db
      .select()
      .from(renditions)
      .where(and(eq(renditions.assetId, a.id), inArray(renditions.kind, spec.kinds)))
      .limit(1);
    if (!r) throw notFound();
    const file = path.join(assetDir(cfg.MEDIA_ROOT, a.id), r.relPath);
    const extra: Record<string, string> = { 'Cache-Control': IMMUTABLE };
    if (r.encrypted) return sendSealed(req, reply, file, (await keysOf(a.id)).fileKey, a.id, spec.type, extra);
    return sendFile(req, reply, file, spec.type, extra);
  });
}
