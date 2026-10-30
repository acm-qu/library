// Video player (Player board). hls.js is loaded on first use; Safari plays HLS natively. Only the rungs that
// exist are offered, and Auto shows which one is playing. Keys while the player has focus: Space, F, M, ← →.
import type { AssetDetail } from '@acm/core/schemas';
import type Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDuration, readyAt } from '../i18n/format.ts';
import { Icon } from './Icon.tsx';

type Level = { index: number; short: number; label: string };

export function VideoPlayer({ asset }: { asset: AssetDetail }) {
  const { t } = useTranslation();
  if (!asset.hlsUrl) {
    if (asset.status === 'ready' || asset.status === 'original_only') return null;
    return (
      <div className="lb-msg" style={{ alignItems: 'stretch', textAlign: 'start', gap: 14, minWidth: 'min(480px, 90vw)' }}>
        <span className="st st-p" style={{ alignSelf: 'flex-start' }}>
          <Icon name="refresh" className="spin" />
          {asset.step ? t('player.processingStep', { step: asset.step }) : asset.status === 'queued' ? t('player.queued') : t('player.processing')}
        </span>
        {asset.readyInS != null && <span className="t-h2 tnum">{t('player.readyAbout', { time: readyAt(asset.readyInS) })}</span>}
        <div className="progress info">
          <span style={{ width: `${Math.round((asset.progress ?? 0) * 100)}%` }} />
        </div>
        <span className="t-sm lb-dim">{t('player.processingNote')}</span>
      </div>
    );
  }
  return <HlsPlayer key={asset.hlsUrl} asset={asset} />;
}

function HlsPlayer({ asset }: { asset: AssetDetail }) {
  const { t } = useTranslation();
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [current, setCurrent] = useState<number>(-1); // playing level
  const [chosen, setChosen] = useState<number>(-1); // -1 = auto
  const [menu, setMenu] = useState(false);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(asset.durationS ?? 0);
  const [fs, setFs] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const v = video.current!;
    let dead = false;
    setError(false);
    if (v.canPlayType('application/vnd.apple.mpegurl') && !(window as { MediaSource?: unknown }).MediaSource) {
      v.src = asset.hlsUrl!;
      return;
    }
    void import('hls.js').then(({ default: HlsCtor }) => {
      if (dead) return;
      if (!HlsCtor.isSupported()) {
        v.src = asset.hlsUrl!;
        return;
      }
      const h = new HlsCtor({
        capLevelToPlayerSize: true,
        maxBufferLength: 30,
        // The server answers 429 while its paced-response slots are full; hls.js only retries 5xx by default.
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10_000,
            maxLoadTimeMs: 120_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000, shouldRetry: (cfg, n, _t, res, retry) => retry || (res?.code === 429 && n < (cfg?.maxNumRetry ?? 0)) },
          },
        },
      });
      hls.current = h;
      h.on(HlsCtor.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels.map((l, index) => { const short = Math.min(l.width, l.height) || l.height; return { index, short, label: `${short}p` }; }).sort((a, b) => b.short - a.short));
      });
      h.on(HlsCtor.Events.LEVEL_SWITCHED, (_e, data) => setCurrent(data.level));
      h.on(HlsCtor.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
        else setError(true);
      });
      h.loadSource(asset.hlsUrl!);
      h.attachMedia(v);
    });
    return () => {
      dead = true;
      hls.current?.destroy();
      hls.current = null;
    };
  }, [asset.hlsUrl, attempt]);

  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const v = () => video.current!;
  const toggle = () => (v().paused ? void v().play() : v().pause());
  const seek = (s: number) => (v().currentTime = Math.max(0, Math.min(duration || 0, s)));
  const pick = (index: number) => {
    setChosen(index);
    if (hls.current) hls.current.currentLevel = index;
    setMenu(false);
  };
  const toggleFs = () => (document.fullscreenElement ? void document.exitFullscreen() : void wrap.current?.requestFullscreen());
  const label = (i: number) => levels.find((l) => l.index === i)?.label ?? '';
  const lowest = levels.at(-1);

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if ((e.target as HTMLElement).closest('[role=menu]')) return;
    if (k === ' ' || k === 'k') toggle();
    else if (k === 'f') toggleFs();
    else if (k === 'm') v().muted = !v().muted;
    else if (k === 'arrowright') seek(time + 5);
    else if (k === 'arrowleft') seek(time - 5);
    else return;
    e.preventDefault();
    e.stopPropagation(); // the lightbox uses ← → for previous/next when the player isn't focused
  };

  return (
    <div ref={wrap} className="player" onKeyDown={onKey} style={asset.width && asset.height ? { ['--ar' as string]: `${asset.width} / ${asset.height}` } : undefined}>
      <video
        ref={video}
        className="player-video"
        poster={asset.posterUrl ?? undefined}
        playsInline
        preload="metadata"
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onError={() => setError(true)}
        onClick={toggle}
      />
      {buffering && !error && (
        <div className="player-center" aria-live="polite">
          <span className="row" style={{ gap: 10 }}>
            <Icon name="spinner" className="spin" />
            <span className="t-sm">{t('player.buffering')}</span>
          </span>
        </div>
      )}
      {paused && !error && !buffering && (
        <button className="player-big" onClick={toggle} aria-label={t('player.play')}>
          <Icon name="play" size="lg" />
        </button>
      )}
      {error && (
        <div className="player-center lb-msg" role="alert">
          <Icon name="alert" size="lg" style={{ color: '#FF8F84' }} />
          <span className="t-h2">{t('player.errorTitle')}</span>
          <span className="t-sm lb-dim">{t('player.errorBody')}</span>
          <div className="row" style={{ gap: 8 }}>
            {lowest && (
              <button
                className="btn btn-s btn-sm"
                onClick={() => {
                  setChosen(lowest.index);
                  setAttempt((n) => n + 1);
                  setTimeout(() => hls.current && (hls.current.currentLevel = lowest.index), 500);
                }}
              >
                {t('player.tryLow', { level: lowest.label })}
              </button>
            )}
            <button className="btn btn-s btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              {t('player.reload')}
            </button>
          </div>
        </div>
      )}
      {!error && (
        <div className="player-controls">
          <input
            className="player-seek"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            aria-label={t('player.seek')}
            aria-valuetext={t('player.seekText', { at: fmtDuration(time), total: fmtDuration(duration) })}
            onChange={(e) => seek(Number(e.target.value))}
            style={{ ['--pct' as string]: `${duration ? (time / duration) * 100 : 0}%` }}
          />
          <div className="row" style={{ gap: 4 }}>
            <button className="btn btn-ic btn-sm" onClick={toggle} aria-label={paused ? t('player.play') : t('player.pause')}>
              <Icon name={paused ? 'play' : 'pause'} />
            </button>
            <button className="btn btn-ic btn-sm" onClick={() => (v().muted = !v().muted)} aria-label={muted ? t('player.unmute') : t('player.mute')}>
              <Icon name={muted ? 'volumeOff' : 'volume'} />
            </button>
            <span className="t-sm tnum" style={{ marginInlineStart: 8 }}>
              {fmtDuration(time)} / {fmtDuration(duration)}
            </span>
            <span className="grow" />
            {levels.length > 1 && (
              <div style={{ position: 'relative' }}>
                <button className="btn btn-sm" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} style={menu ? { background: 'rgba(255,255,255,.16)' } : undefined}>
                  <Icon name="sliders" />
                  <span className="tnum">{chosen === -1 ? (current >= 0 ? t('player.autoNow', { level: label(current) }) : t('player.auto')) : label(chosen)}</span>
                </button>
                {menu && (
                  <div className="menu player-menu" role="menu" aria-label={t('player.quality')}>
                    <span className="t-over" style={{ display: 'block', padding: '6px 14px' }}>
                      {t('player.quality')}
                    </span>
                    {[{ index: -1, label: t('player.auto'), short: 0 }, ...levels].map((l) => (
                      <button key={l.index} role="menuitemradio" aria-checked={chosen === l.index} onClick={() => pick(l.index)}>
                        <span style={{ width: 16 }}>{chosen === l.index && <Icon name="ok" size="sm" />}</span>
                        <span className="grow">{l.label}</span>
                        <span className="t-xs subtle tnum">{l.index === -1 && current >= 0 ? t('player.now', { level: label(current) }) : l.short >= 1080 ? t('player.hd') : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button className="btn btn-ic btn-sm" onClick={toggleFs} aria-label={fs ? t('player.exitFullscreen') : t('player.fullscreen')}>
              <Icon name="fullscreen" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
