// ffprobe classification and the ffmpeg command for the HLS ladder (handoff §8.4). Pure builders, tested
// separately from the process that runs them.
export type Stream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_transfer?: string;
  color_primaries?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number; dv_profile?: number }[];
};
export type ProbeJson = { streams?: Stream[]; format?: { duration?: string; tags?: Record<string, string> } };

export type Classified =
  | { kind: 'needs_review'; reason: 'unknown_transfer' | 'no_video'; transfer: string | null }
  | {
      kind: 'ok';
      hdr: 'sdr' | 'hlg' | 'pq';
      width: number; // displayed (after rotation)
      height: number;
      durationS: number;
      fps: number;
      vfr: boolean;
      hasAudio: boolean;
      capturedAt: string | null;
      device: string | null;
      dvProfile: number | null;
    };

const SDR_TRANSFERS = new Set(['bt709', 'smpte170m', 'bt470bg', 'bt470m', 'iec61966-2-1', 'gamma22', 'gamma28']);
const rate = (r: string | undefined) => {
  const [n, d] = (r ?? '0/1').split('/').map(Number);
  return n && d ? n / d : 0;
};

/** `force`: an admin chose "Process anyway" for an unknown transfer; encode it as SDR with BT.709 tags, no tone mapping. */
export function classify(p: ProbeJson, force = false): Classified {
  const v = p.streams?.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg');
  if (!v?.width || !v.height) return { kind: 'needs_review', reason: 'no_video', transfer: null };
  const transfer = v.color_transfer && v.color_transfer !== 'unknown' ? v.color_transfer : null;
  const tenBit = /(10|12)(le|be)?$/.test(v.pix_fmt ?? '');
  let hdr: 'sdr' | 'hlg' | 'pq';
  if (transfer === 'arib-std-b67') hdr = 'hlg';
  else if (transfer === 'smpte2084') hdr = 'pq';
  else if ((transfer && SDR_TRANSFERS.has(transfer)) || (!transfer && !tenBit)) hdr = 'sdr';
  else if (force) hdr = 'sdr';
  else return { kind: 'needs_review', reason: 'unknown_transfer', transfer };

  const rotation = Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  const quarter = Math.abs(rotation) % 180 === 90;
  const avg = rate(v.avg_frame_rate);
  const r = rate(v.r_frame_rate);
  const fps = avg || r || 30;
  const tags = { ...p.format?.tags, ...v.tags };
  const make = tags['com.apple.quicktime.make'] ?? tags.make;
  const model = tags['com.apple.quicktime.model'] ?? tags.model;
  const created = tags['com.apple.quicktime.creationdate'] ?? tags.creation_time ?? null;
  return {
    kind: 'ok',
    hdr,
    width: quarter ? v.height : v.width,
    height: quarter ? v.width : v.height,
    durationS: Number(p.format?.duration) || 0,
    fps,
    // iPhones record slightly variable rates (avg 29.996 vs nominal 29.97); anything off by > 0.05% is VFR.
    vfr: !!avg && !!r && Math.abs(avg - r) / r > 0.0005,
    hasAudio: !!p.streams?.some((s) => s.codec_type === 'audio'),
    capturedAt: created && !Number.isNaN(Date.parse(created)) ? new Date(created).toISOString() : null,
    device: model ? (make && !model.startsWith(make) ? `${make} ${model}` : model) : null,
    dvProfile: v.side_data_list?.find((s) => s.dv_profile !== undefined)?.dv_profile ?? null,
  };
}

export type Rung = { name: string; h: number; crf: number; maxrate: string; bufsize: string; audio: string };
const LADDER: Rung[] = [
  { name: '360p', h: 360, crf: 26, maxrate: '1M', bufsize: '2M', audio: '96k' },
  { name: '720p', h: 720, crf: 23, maxrate: '3M', bufsize: '6M', audio: '128k' },
  { name: '1080p', h: 1080, crf: 22, maxrate: '6M', bufsize: '12M', audio: '128k' },
];

/** Rungs by the shorter side; never upscale; always at least one (at the source size when it is tiny). */
export function ladder(width: number, height: number): Rung[] {
  const short = Math.min(width, height);
  const fit = LADDER.filter((r) => r.h <= short);
  if (fit.length) return fit;
  const h = short - (short % 2);
  return [{ ...LADDER[0]!, name: `${h}p`, h }];
}

/** Video filter before the split: SDR passes through; HDR uses the Hable fallback chain verified on the host. */
export function baseFilter(hdr: 'sdr' | 'hlg' | 'pq', lut?: string): string {
  if (hdr === 'sdr') return 'format=yuv420p';
  const tin = hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  if (lut) {
    // Table path (Milestone 10): RGB without changing transfer or primaries, apply the curve, then BT.709 TV range.
    return `zscale=tin=${tin}:min=bt2020nc:pin=bt2020:t=${tin}:p=bt2020,format=gbrpf32le,lut3d=file='${lut.replace(/'/g, "\\'")}':interp=tetrahedral,zscale=t=bt709:m=bt709:p=bt709:r=tv,format=yuv420p`;
  }
  return `zscale=tin=${tin}:min=bt2020nc:pin=bt2020:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
}

const scaleFor = (h: number) => `scale=w='if(gte(iw,ih),-2,${h})':h='if(gte(iw,ih),${h},-2)'`;

export function hlsArgs(o: {
  src: string;
  out: string; // directory that receives hls/
  rungs: Rung[];
  vf: string;
  fps: number;
  vfr: boolean;
  hasAudio: boolean;
  keyInfo?: string;
}): string[] {
  const n = o.rungs.length;
  const fps = Math.round(o.fps) || 30;
  const g = String(2 * fps);
  const split = n > 1 ? `,split=${n}${o.rungs.map((_, i) => `[s${i}]`).join('')}` : '[s0]';
  const fc = `[0:v]${o.vf}${split};${o.rungs.map((r, i) => `[s${i}]${scaleFor(r.h)}[v${i}]`).join(';')}`;
  const args = ['-nostdin', '-hide_banner', '-y', '-threads', '2', '-i', o.src, '-filter_complex_threads', '2', '-filter_complex', fc];
  o.rungs.forEach((_, i) => {
    args.push('-map', `[v${i}]`);
    if (o.hasAudio) args.push('-map', '0:a:0');
  });
  args.push('-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p');
  o.rungs.forEach((r, i) => args.push(`-crf:v:${i}`, String(r.crf), `-maxrate:v:${i}`, r.maxrate, `-bufsize:v:${i}`, r.bufsize));
  if (o.vfr) args.push('-fps_mode', 'cfr', '-r', String(fps));
  args.push('-g', g, '-keyint_min', g, '-sc_threshold', '0');
  args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  if (o.hasAudio) {
    args.push('-c:a', 'aac', '-ac', '2');
    o.rungs.forEach((r, i) => args.push(`-b:a:${i}`, r.audio));
  }
  args.push('-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+single_file');
  if (o.keyInfo) args.push('-hls_key_info_file', o.keyInfo);
  args.push('-master_pl_name', 'master.m3u8');
  args.push('-var_stream_map', o.rungs.map((r, i) => (o.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`)).join(' '));
  args.push('-hls_segment_filename', `${o.out}/hls/%v/data.ts`, `${o.out}/hls/%v/index.m3u8`);
  args.push('-progress', 'pipe:1', '-nostats');
  return args;
}

/** BANDWIDTH and RESOLUTION for each variant in a master playlist, keyed by the variant's directory name. */
export function parseMaster(text: string): Map<string, { bandwidth: number; width: number | null; height: number | null }> {
  const out = new Map<string, { bandwidth: number; width: number | null; height: number | null }>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith('#EXT-X-STREAM-INF:')) continue;
    const bw = /BANDWIDTH=(\d+)/.exec(l);
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(l);
    const uri = lines[i + 1]?.trim() ?? '';
    const name = uri.split('/')[0]!;
    out.set(name, { bandwidth: bw ? Number(bw[1]) : 0, width: res ? Number(res[1]) : null, height: res ? Number(res[2]) : null });
  }
  return out;
}
