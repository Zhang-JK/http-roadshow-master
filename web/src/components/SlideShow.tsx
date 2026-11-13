import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeckDoc } from '../types';
import { SlideFrame } from './SlideFrame';

const NEXT = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
const PREV = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];

interface Props {
  doc: DeckDoc;
  startIndex: number;
  /** Called with the page the show ended on. */
  onClose: (index: number) => void;
}

/**
 * Full-screen slide show of a deck, read-only. Every page is rendered up front and cross-faded, so
 * moving on never flashes a blank page. Click (or → / Space) for the next page, the left edge (or ←)
 * for the previous one; Esc, the ✕ button or clicking past the last page ends it.
 */
export function SlideShow({ doc, startIndex, onClose }: Props) {
  const pages = doc.pages;
  const [index, setIndex] = useState(() => Math.max(0, Math.min(pages.length - 1, startIndex)));
  const [chrome, setChrome] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(index);
  const closed = useRef(false);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    onClose(indexRef.current);
  }, [onClose]);

  const go = useCallback(
    (d: number) => {
      const next = indexRef.current + d;
      if (next >= pages.length) close();
      else setIndex(Math.max(0, next));
    },
    [pages.length, close],
  );

  useEffect(() => {
    rootRef.current?.focus();
    rootRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    let entered = !!document.fullscreenElement;
    const onChange = () => {
      if (document.fullscreenElement) entered = true;
      // Leaving full screen (the browser handles Esc itself there) ends the show.
      else if (entered) close();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [close]);

  // Capture phase, so the editor's own shortcuts (page keys, Esc) do not act behind the show.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (NEXT.includes(e.key)) go(1);
      else if (PREV.includes(e.key)) go(-1);
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(pages.length - 1);
      else if (e.key === 'Escape') close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, close, pages.length]);

  // The page number and exit button show while the mouse moves, then get out of the way.
  useEffect(() => {
    if (!chrome) return;
    const t = setTimeout(() => setChrome(false), 2200);
    return () => clearTimeout(t);
  }, [chrome, index]);

  return (
    <div
      ref={rootRef}
      className={`slideshow ${chrome ? '' : 'idle'}`}
      tabIndex={-1}
      onMouseMove={() => setChrome(true)}
      onClick={(e) => go(e.clientX < window.innerWidth * 0.2 ? -1 : 1)}
      data-testid="slideshow"
    >
      {pages.map((p, i) => (
        <div key={p.id} className={`slideshow-slide ${i === index ? 'on' : ''}`} aria-hidden={i !== index}>
          <SlideFrame doc={doc} pageId={p.id} width={doc.width} height={doc.height} fitHeight title={`第 ${i + 1} 页`} />
        </div>
      ))}
      <div className="slideshow-count" data-testid="slideshow-count">{index + 1} / {pages.length}</div>
      <button className="slideshow-exit" onClick={(e) => { e.stopPropagation(); close(); }} aria-label="退出放映" title="退出放映（Esc）" data-testid="slideshow-exit">
        ✕
      </button>
    </div>
  );
}
