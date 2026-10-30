// One sliding highlight per tab bar (the container's ::after), so switching tabs moves it instead of fading tabs.
import { useLayoutEffect, useRef } from 'react';

type Shape = 'line-bottom' | 'line-top' | 'fill';

export function useTabIndicator<T extends HTMLElement>(shape: Shape, active: unknown) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    let frame = 0;
    const place = () => {
      const tab = bar.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
      if (!tab) return void delete bar.dataset.ind;
      const line = 2;
      const y = shape === 'line-bottom' ? tab.offsetTop + tab.offsetHeight - line : tab.offsetTop;
      bar.style.setProperty('--ind-x', `${tab.offsetLeft}px`);
      bar.style.setProperty('--ind-y', `${y}px`);
      bar.style.setProperty('--ind-w', `${tab.offsetWidth}px`);
      bar.style.setProperty('--ind-h', `${shape === 'fill' ? tab.offsetHeight : line}px`);
      // The first placement jumps into position; only later moves slide.
      if (!bar.dataset.ind) {
        bar.dataset.ind = shape;
        frame = requestAnimationFrame(() => (bar.dataset.slide = ''));
      }
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(bar);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [shape, active]);
  return ref;
}
