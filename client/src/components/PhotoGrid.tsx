import { useState } from 'react';
import type { Photo } from '../../../shared/types';
import { thumbUrl } from '../api';
import { formatDuration } from '../util';

/** Play triangle + duration overlaid on a video's poster thumbnail. */
export function VideoOverlay({ photo }: { photo: Photo }) {
  return (
    <>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white">▶</span>
      </span>
      {photo.durationSec !== null && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white">
          {formatDuration(photo.durationSec)}
        </span>
      )}
    </>
  );
}

/**
 * Thumbnail that degrades to a labelled placeholder when the server can't
 * decode the file (e.g. HEIC without a working decoder) — never a broken img.
 */
export function Thumb({ photo, size = 256, className }: { photo: Photo; size?: 256 | 1024; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    const ext = photo.filename.split('.').pop()?.toUpperCase() ?? 'FILE';
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1 bg-slate-800 text-slate-400 ${className ?? ''}`}
        data-testid="thumb-placeholder"
      >
        <span className="text-2xl">🖼️</span>
        <span className="text-[10px] font-semibold">{ext}</span>
        <span className="px-1 text-center text-[9px] leading-tight">no preview available</span>
      </div>
    );
  }
  return (
    <img
      src={thumbUrl(photo.id, size)}
      alt={photo.caption || photo.filename}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`bg-slate-800 object-cover ${className ?? ''}`}
    />
  );
}

export function PhotoGrid({
  photos,
  onOpen,
  selectMode = false,
  selectedIds,
  onToggleSelect,
  draggable = false,
}: {
  photos: Photo[];
  onOpen: (index: number) => void;
  selectMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  draggable?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {photos.map((photo, i) => {
        const selected = selectedIds?.has(photo.id) ?? false;
        return (
          <button
            key={photo.id}
            onClick={() => (selectMode ? onToggleSelect?.(photo.id) : onOpen(i))}
            draggable={draggable && !selectMode}
            onDragStart={(e) => e.dataTransfer.setData('text/plain', photo.id)}
            className={`relative aspect-square overflow-hidden rounded-md focus:outline-none focus:ring-2 focus:ring-pink-400 ${
              selected ? 'ring-2 ring-pink-400' : ''
            }`}
            data-testid="photo-tile"
          >
            <Thumb photo={photo} className="absolute inset-0 h-full w-full" />
            {photo.kind === 'video' && <VideoOverlay photo={photo} />}
            {photo.milestone && (
              <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[9px] text-amber-300">
                ★ {photo.milestone}
              </span>
            )}
            {selectMode && (
              <span
                className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 text-[11px] ${
                  selected ? 'border-pink-400 bg-pink-500 text-white' : 'border-white/80 bg-black/40 text-transparent'
                }`}
              >
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
