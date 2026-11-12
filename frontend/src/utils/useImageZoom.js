import { useEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const WHEEL_STEP = 0.15;

/**
 * Zoom com scroll do mouse + arrastar pra navegar quando ampliado, pra
 * visualização de imagem em tela cheia (ImageLightbox, MediaGallery). Não se
 * aplica a vídeo — os controles nativos precisam dos cliques normais.
 * Reresetado sempre que `resetKey` muda (nova imagem aberta).
 */
export default function useImageZoom(resetKey) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [resetKey]);

  const handleWheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
    setScale(prev => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta));
      if (next === MIN_SCALE) setPos({ x: 0, y: 0 });
      return next;
    });
  };

  const handleMouseDown = (e) => {
    if (scale <= MIN_SCALE) return;
    draggingRef.current = true;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastPointRef.current.x;
    const dy = e.clientY - lastPointRef.current.y;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
    setPos(prev => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  const stopDragging = () => { draggingRef.current = false; };

  const resetZoom = () => { setScale(1); setPos({ x: 0, y: 0 }); };

  return {
    scale,
    isZoomed: scale > MIN_SCALE,
    containerHandlers: {
      onWheel: handleWheel,
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: stopDragging,
      onMouseLeave: stopDragging,
      onDoubleClick: resetZoom,
    },
    mediaStyle: {
      transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
      cursor: scale > MIN_SCALE ? 'grab' : 'zoom-in',
    },
  };
}
