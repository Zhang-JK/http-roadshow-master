import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import type { DeckDoc } from '../types';
import { pageHtml } from '../lib/slideHtml';

interface Props {
  doc?: DeckDoc;
  pageId?: string;
  /** Alternative to doc: load a server-rendered page. */
  src?: string;
  width: number;
  height: number;
  editor?: boolean;
  initialSelection?: string[];
  className?: string;
  /** Fit inside the container height as well as width. */
  fitHeight?: boolean;
  title?: string;
}

/** Renders a fixed-size slide in an iframe scaled to fit its container. */
export const SlideFrame = forwardRef<HTMLIFrameElement, Props>(function SlideFrame(
  { doc, pageId, src, width, height, editor, initialSelection, className, fitHeight, title },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => {
      const parent = el.parentElement!;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const s = fitHeight && h > 0 ? Math.min(w / width, h / height) : w / width;
      setScale(s > 0 ? s : 0);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el.parentElement!);
    return () => ro.disconnect();
  }, [width, height, fitHeight]);

  const selectionKey = editor ? (initialSelection ?? []).join(',') : '';
  const srcDoc = useMemo(
    () => (doc && pageId !== undefined ? pageHtml(doc, pageId, { editor, initialSelection }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, pageId, editor, selectionKey],
  );

  return (
    <div
      ref={boxRef}
      className={`slide-frame ${className ?? ''}`}
      style={{ width: width * scale, height: height * scale }}
    >
      {scale > 0 && (
        <iframe
          ref={ref}
          title={title ?? 'slide'}
          srcDoc={srcDoc}
          src={srcDoc ? undefined : src}
          loading={src ? 'lazy' : undefined}
          sandbox={editor ? 'allow-scripts allow-same-origin' : 'allow-same-origin'}
          style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0, display: 'block' }}
          tabIndex={editor ? 0 : -1}
        />
      )}
    </div>
  );
});
