import { describe, expect, it } from 'vitest';
import type { Item } from '../src/lib/uploader.ts';

// The module listens for online/offline on window; node has no such listener.
(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {};
const { toStart } = await import('../src/lib/uploader.ts');

const item = (name: string, status: Item['status'] = 'waiting') => ({ key: name, file: { name, type: name.endsWith('.mov') ? 'video/quicktime' : 'image/jpeg' } as File, status }) as Item;

describe('upload scheduling', () => {
  it('runs two files at a time, at most one video', () => {
    expect(toStart([item('a.mov'), item('b.mov'), item('c.jpg')]).map((i) => i.key)).toEqual(['a.mov', 'c.jpg']);
    expect(toStart([item('a.mov', 'uploading'), item('b.mov'), item('c.jpg'), item('d.jpg')]).map((i) => i.key)).toEqual(['c.jpg']);
    expect(toStart([item('a.jpg', 'uploading'), item('b.mov'), item('c.mov')]).map((i) => i.key)).toEqual(['b.mov']);
    expect(toStart([item('a.jpg'), item('b.jpg'), item('c.jpg')]).map((i) => i.key)).toEqual(['a.jpg', 'b.jpg']);
    expect(toStart([item('a.mov', 'uploading'), item('b.mov')])).toEqual([]);
  });
});
