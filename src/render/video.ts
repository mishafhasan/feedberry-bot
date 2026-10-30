import { clampMessage, esc, type MediaFile, type MessagePlan } from './plan.ts';

/** Bot API upload ceiling for multipart sends [TG-FILES]. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** R9 (M5): duration is unknown until the probe lands in M6, so size alone decides. */
export function renderVideo(file: MediaFile, caption: string, link: string): MessagePlan {
  if (file.size <= MAX_UPLOAD_BYTES) return { kind: 'video', file: file.path, caption };
  // shortcut: over 50 MB becomes a link card; M6 adds the thumbnail (R7/R8, ADR-012).
  return { kind: 'link_only', text: `${clampMessage(caption, 4000)}\n\n${esc(link)}` };
}
