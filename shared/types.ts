export type TakenAtSource = 'exif' | 'container' | 'file' | 'manual';
export type PhotoStatus = 'active' | 'trashed';
export type MediaKind = 'photo' | 'video';

export interface Child {
  id: string;
  name: string;
  birthDate: string | null; // ISO date (YYYY-MM-DD); null only after a rebuild-from-folders
  color: string;
  createdAt: string;
}

export interface Photo {
  id: string;
  contentHash: string;
  childIds: string[];
  takenAt: string; // ISO datetime
  takenAtSource: TakenAtSource;
  relPath: string; // path relative to PHOTOS_ROOT, forward slashes
  filename: string;
  mimeType: string;
  kind: MediaKind; // derived from mimeType; 'video' for video/*, else 'photo'
  width: number;
  height: number;
  durationSec: number | null; // videos only; null for images
  sizeBytes: number;
  caption: string;
  tags: string[];
  milestone: string | null;
  status: PhotoStatus;
  trashedAt: string | null;
  createdAt: string;
}

export interface MetadataSnapshot {
  app: string;
  formatVersion: number;
  exportedAt: string;
  children: Child[];
  photos: Photo[];
  settings: Record<string, string>;
}

export const METADATA_FORMAT_VERSION = 1;
export const TRASH_RETENTION_DAYS = 30;
