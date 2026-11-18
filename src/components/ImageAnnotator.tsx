import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Minus, Download, Undo, Trash2, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import ControlPanel from './ControlPanel';
import { useMarkers } from '@/hooks/useMarkers';
import { usePersistedSettings } from '@/hooks/usePersistedSettings';
import { downloadAnnotatedImage } from '@/utils/downloadUtils';
import { getMarkerAtPosition } from '@/utils/canvasUtils';
import type { Marker } from '@/lib/types';

const FIXED_IMAGE = '/begonias_in_eu_col_d.jpg';
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function ImageAnnotator() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDownloading, setIsDownloading] = useState(false);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number; centerX: number; centerY: number } | null>(null);
  const { markers, hoveredMarkerId, setHoveredMarkerId, addMarker, removeMarker, undoLastMarker, clearAllMarkers, updateMarkerCounts } = useMarkers();
  const { settings: markerSettings, updateSettings: setMarkerSettings } = usePersistedSettings();

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.onerror = () => toast.error('Could not load the Begonia image');
    img.src = FIXED_IMAGE;
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    markers.forEach((marker) => {
      ctx.save();
      ctx.fillStyle = marker.color;
      ctx.globalAlpha = marker.opacity / 100;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, Math.max(5, marker.size), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = marker.borderColor;
      ctx.lineWidth = marker.borderSize;
      ctx.stroke();
      if (marker.showCount && marker.count !== undefined) {
        ctx.fillStyle = marker.countColor || '#ffffff';
        ctx.font = `bold ${marker.countFontSize || 14}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.strokeText(String(marker.count), marker.x, marker.y);
        ctx.fillText(String(marker.count), marker.x, marker.y);
      }
      ctx.restore();
    });
  }, [image, markers]);

  useEffect(() => { redraw(); }, [redraw, hoveredMarkerId]);

  const fitAndReset = useCallback(() => {
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
    setPan(panRef.current);
  }, []);

  useEffect(() => {
    fitAndReset();
    const handler = () => fitAndReset();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [fitAndReset, image]);

  const setZoomAtPoint = (nextZoom: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const localX = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const localY = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const next = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const old = zoom;
    const cx = (localX - panRef.current.x) / old;
    const cy = (localY - panRef.current.y) / old;
    const nextPan = { x: localX - cx * next, y: localY - cy * next };
    const maxX = Math.max(0, (rect.width * next - rect.width) / 2);
    const maxY = Math.max(0, (rect.height * next - rect.height) / 2);
    nextPan.x = clamp(nextPan.x, -maxX, maxX);
    nextPan.y = clamp(nextPan.y, -maxY, maxY);
    panRef.current = nextPan;
    setPan(nextPan);
    setZoom(next);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: panRef.current.x, panY: panRef.current.y };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || zoom <= 1) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    const maxX = Math.max(0, (rect.width * zoom - rect.width) / 2);
    const maxY = Math.max(0, (rect.height * zoom - rect.height) / 2);
    const next = {
      x: clamp(dragRef.current.panX + dx, -maxX, maxX),
      y: clamp(dragRef.current.panY + dy, -maxY, maxY),
    };
    panRef.current = next;
    setPan(next);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * image.naturalWidth;
    const y = ((event.clientY - rect.top) / rect.height) * image.naturalHeight;

    const displayMarkers: Marker[] = markers.map((marker) => ({
      ...marker,
      x: (marker.x / image.naturalWidth) * rect.width,
      y: (marker.y / image.naturalHeight) * rect.height,
      size: Math.max(5, (marker.size / image.naturalWidth) * rect.width),
    }));
    const local = getMarkerAtPosition(event.clientX - rect.left, event.clientY - rect.top, displayMarkers);
    if (local) {
      removeMarker(local.id);
      return;
    }

    addMarker(clamp(x, 0, image.naturalWidth), clamp(y, 0, image.naturalHeight), {
      ...markerSettings,
      size: Math.max(5, markerSettings.size),
    });
  };

  const touchDistance = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2) {
      const midpointX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const midpointY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      pinchRef.current = { distance: touchDistance(event.touches), zoom, centerX: midpointX, centerY: midpointY };
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2 && pinchRef.current) {
      event.preventDefault();
      const distance = touchDistance(event.touches);
      const midpointX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const midpointY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      setZoomAtPoint(pinchRef.current.zoom * (distance / pinchRef.current.distance), midpointX, midpointY);
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoomAtPoint(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX, event.clientY);
  };

  const handleDownload = async () => {
    if (!image) return;
    setIsDownloading(true);
    try {
      await downloadAnnotatedImage(image, markers, { width: image.naturalWidth, height: image.naturalHeight });
      toast.success('Original-resolution image downloaded');
    } catch {
      toast.error('Failed to download image');
    } finally {
      setIsDownloading(false);
    }
  };

  const resetCount = () => {
    const settings = { ...markerSettings, countStartFrom: 1 };
    setMarkerSettings(settings);
    updateMarkerCounts(1, settings);
  };

  return (
    <main className="fixed inset-0 flex flex-col bg-neutral-950 text-white overflow-hidden">
      <header className="h-14 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-white/10 bg-neutral-950/95 z-40">
        <div className="flex items-center gap-2 min-w-0">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="Marker settings"><Settings className="h-5 w-5" /></Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(18rem,calc(100vw-1.5rem))] p-0"><ControlPanel settings={markerSettings} onSettingsChange={setMarkerSettings} markerCount={markers.length} onResetCount={resetCount} /></PopoverContent>
          </Popover>
          <span className="font-semibold truncate">Begonia Marker</span>
          <span className="hidden sm:inline text-xs text-white/50">{markers.length} markers</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-10 w-10" onClick={undoLastMarker} disabled={!markers.length} aria-label="Undo"><Undo className="h-5 w-5" /></Button>
          <Button variant="ghost" size="icon" className="h-10 w-10" onClick={clearAllMarkers} disabled={!markers.length} aria-label="Clear markers"><Trash2 className="h-5 w-5" /></Button>
          <Button variant="secondary" className="h-10 px-3" onClick={handleDownload} disabled={!image || isDownloading}>
            <Download className="h-4 w-4 mr-2" /> <span className="hidden sm:inline">Download</span>
          </Button>
        </div>
      </header>

      <section
        ref={viewportRef}
        className="relative flex-1 overflow-hidden touch-none select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
      >
        {image ? (
          <div
            className="absolute left-1/2 top-1/2 origin-center"
            style={{
              transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`,
            }}
          >
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              className="block max-w-none rounded shadow-2xl"
              style={{
                width: 'min(calc(100vw - 24px), calc((100vh - 80px) * 1.5))',
                height: 'auto',
                aspectRatio: `${image.naturalWidth} / ${image.naturalHeight}`,
                cursor: zoom > 1 ? 'grab' : 'crosshair',
              }}
              aria-label="Begonia marker canvas"
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/60">Loading image…</div>
        )}

        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 rounded-xl border border-white/10 bg-neutral-900/95 p-1 shadow-xl">
          <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setZoomAtPoint(zoom / 1.25)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out"><Minus class="h-5 w-5" /></Button>
          <button className="min-w-14 text-sm tabular-nums" onClick={fitAndReset} aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
          <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setZoomAtPoint(zoom * 1.25)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in"><Plus class="h-5 w-5" /></Button>
        </div>
      </section>
    </main>
  );
}
