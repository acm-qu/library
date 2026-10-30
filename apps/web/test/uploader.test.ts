import { describe, expect, it } from 'vitest';
import type { Item } from '../src/lib/uploader.ts';

// The module listens for online/offline on window; node has no such listener.
(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {};
const { chunkPacer, toStart } = await import('../src/lib/uploader.ts');

const item = (name: string, status: Item['status'] = 'waiting') => ({ key: name, file: { name, type: name.endsWith('.mov') ? 'video/quicktime' : 'image/jpeg' } as File, status }) as Item;

describe('upload pacing', () => {
  it('spaces chunk requests 8 MiB / 21 MiB/s apart and never waits when already slower', () => {
    let t = 1000;
    const next = chunkPacer(() => t);
    expect(next()).toBe(0);
    expect(next()).toBeCloseTo((8 / 21) * 1000, 0);
    t += 5000;
    expect(next()).toBe(0);
  });
});

describe('upload scheduling', () => {
  it('runs two files at a time, at most one video', () => {
    expect(toStart([item('a.mov'), item('b.mov'), item('c.jpg')]).map((i) => i.key)).toEqual(['a.mov', 'c.jpg']);
    expect(toStart([item('a.mov', 'uploading'), item('b.mov'), item('c.jpg'), item('d.jpg')]).map((i) => i.key)).toEqual(['c.jpg']);
    expect(toStart([item('a.jpg', 'uploading'), item('b.mov'), item('c.mov')]).map((i) => i.key)).toEqual(['b.mov']);
    expect(toStart([item('a.jpg'), item('b.jpg'), item('c.jpg')]).map((i) => i.key)).toEqual(['a.jpg', 'b.jpg']);
    expect(toStart([item('a.mov', 'uploading'), item('b.mov')])).toEqual([]);
  });
});

describe('server upload queue', () => {
  it('holds a new file as queued with its place in line, and hands it to the scheduler once granted', async () => {
    const { currentUploads, uploader } = await import('../src/lib/uploader.ts');
    const items = () => currentUploads()[0];
    const ticketId = '01900000-0000-7000-8000-000000000001';
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ id: ticketId, state: 'waiting', position: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const file = { name: 'IMG_1.JPG', type: 'image/jpeg', size: 1000, lastModified: 1 } as File;
    uploader.add([{ file, tier: 'member' }], '01900000-0000-7000-8000-0000000000ee');
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['POST /api/uploads/tickets']);
    expect(items()).toMatchObject({ status: 'queued', ticketId, position: 3 });

    const row = { state: 'waiting' as const, position: 2, uploader: 'Me', kind: 'photo' as const, bytes: 1000, progress: null, createdAt: new Date().toISOString(), ticketId, filename: 'IMG_1.JPG' };
    uploader.sync({ slots: 4, inUse: 4, rateBps: 0, items: [row] });
    expect(items()).toMatchObject({ status: 'queued', position: 2 });
    uploader.sync({ slots: 4, inUse: 1, rateBps: 0, items: [{ ...row, state: 'uploading', position: 1, progress: 0 }] });
    expect(items()).toMatchObject({ status: 'waiting', ticketId }); // granted: the 2-at-a-time rule starts it (navigator.onLine is unset in node)
  });
});
