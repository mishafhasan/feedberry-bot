import { clampMessage, esc, type MediaFile, type MessagePlan } from './plan.ts';

/** Bot API upload ceiling for multipart sends [TG-FILES]. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** The 3-minute rule of §8.1 R6–R8. */
export const LONG_VIDEO_SEC = 180;

export interface VideoFacts {
  durationSec: number | null;
  thumbnail: string | null;
  link: string;
}

/**
 * R6/R7/R8/R9 (§8.1, ADR-012). The size and duration come from the downloaded file, never from a
 * partial upload: over 50 MB nothing is sent, the preview plus the link is.
 */
export function renderVideo(file: MediaFile, caption: string, facts: VideoFacts): MessagePlan {
  const tooBig = file.size > MAX_UPLOAD_BYTES;
  const seconds = facts.durationSec;
  const long = seconds !== null && seconds >= LONG_VIDEO_SEC;

  // R6: short enough and small enough → real video. R9: unknown duration, size decides.
  if (!long && !tooBig) return { kind: 'video', file: file.path, caption };

  // R7/R8: thumbnail + caption + link, or just the link when no thumbnail can be made.
  if (facts.thumbnail) return { kind: 'thumbnail', file: facts.thumbnail, caption, link: facts.link };
  return { kind: 'link_only', text: `${clampMessage(caption, 4000)}\n\n${esc(facts.link)}` };
}
