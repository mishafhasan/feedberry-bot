import { clampMessage, esc, type MediaFile, type MessagePlan } from './plan.ts';

/** Bot API upload ceiling for multipart sends [TG-FILES]. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** The 3-minute rule of §8.1 R6–R8. */
export const LONG_VIDEO_SEC = 180;

export interface VideoFacts {
  durationSec: number | null;
  /** Platform poster first, then the ffmpeg frame; a URL means Telegram fetches it. */
  thumbnail: string | null;
  thumbnailRemote?: boolean;
  link: string;
}

/** R15: past the ceiling a file is never uploaded, whatever the post looks like. */
export const overCeiling = (file: MediaFile): boolean => file.size > MAX_UPLOAD_BYTES;

/**
 * R15: a file that never landed, or that Telegram refuses, links from the caption instead of
 * uploading. A failed download is not a lost post.
 */
export const unsendable = (file: MediaFile): boolean => file.path === '' || overCeiling(file);

/** R15: what an album may upload — anything past the ceiling is left out, the caption links it. */
export function albumMedia(files: MediaFile[]): Array<{ file: string; kind: 'photo' | 'video' }> {
  return files
    .filter((file) => !unsendable(file))
    .map((file) => ({ file: file.path, kind: file.kind === 'video' ? 'video' : 'photo' }));
}

/** R15: the caption ends with one clickable line per video that could not be uploaded. */
export function withVideoLinks(caption: string, files: MediaFile[]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (file.kind === 'video' && unsendable(file) && file.url) lines.push(`🎬 ${esc(file.url)}`);
  }
  return lines.length === 0 ? caption : `${caption}\n\n${lines.join('\n')}`;
}

/**
 * R3/R4/R15: 2–10 items per group. A lone survivor travels as a single media message instead, because
 * `sendMediaGroup` refuses fewer than two, and a post with nothing left keeps its words and links.
 */
export function renderAlbum(files: MediaFile[], caption: string): MessagePlan {
  const items = albumMedia(files);
  const text = withVideoLinks(caption, files);
  const [only] = items;
  if (!only) return { kind: 'text', text: clampMessage(text) };
  if (items.length === 1) return { kind: only.kind, file: only.file, caption: text };
  return { kind: 'album', items, caption: text };
}

/**
 * R6/R7/R8/R9 (§8.1, ADR-012). The size and duration come from the downloaded file, never from a
 * partial upload: over 50 MB nothing is sent, the preview plus the link is.
 */
export function renderVideo(file: MediaFile, caption: string, facts: VideoFacts): MessagePlan {
  const tooBig = unsendable(file);
  const seconds = facts.durationSec;
  const long = seconds !== null && seconds >= LONG_VIDEO_SEC;

  // R6: short enough and small enough → real video. R9: unknown duration, size decides.
  if (!long && !tooBig) return { kind: 'video', file: file.path, caption };

  // R7/R8: thumbnail + caption + link, or just the link when no thumbnail can be made.
  if (facts.thumbnail) {
    return { kind: 'thumbnail', file: facts.thumbnail, caption, link: facts.link, remote: facts.thumbnailRemote === true };
  }
  return { kind: 'link_only', text: `${clampMessage(caption, 4000)}\n\n${esc(facts.link)}` };
}
