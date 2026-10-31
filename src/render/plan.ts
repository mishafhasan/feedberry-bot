/** The pipeline's rendering contract (§8): a plan is data, sending is stage 7. */
export type MediaKind = 'photo' | 'video' | 'audio' | 'animation';

/** One downloaded file, ready to upload. */
export interface MediaFile {
  path: string;
  kind: MediaKind;
  size: number;
}

export type MessagePlan =
  | { kind: 'text'; text: string }
  | { kind: 'link_only'; text: string }
  | { kind: 'photo' | 'video' | 'animation' | 'audio'; file: string; caption: string }
  /** R7/R8: thumbnail photo, then the source link. `remote` means Telegram fetches it itself. */
  | { kind: 'thumbnail'; file: string; caption: string; link: string; remote?: boolean }
  /** R3/R4: one `sendMediaGroup` per 10 items. Photos and videos may share a group. */
  | { kind: 'album'; items: Array<{ file: string; kind: 'photo' | 'video' }>; caption: string };

/** What a `posts.payload_json` row carries from stage 2 to the renderer. */
export interface PostPayload {
  title: string;
  summary: string | null;
  media: Array<{ url: string; type: string }>;
}

export function payloadOf(payloadJson: string | null): PostPayload {
  try {
    const parsed = JSON.parse(payloadJson ?? '{}') as Partial<PostPayload>;
    return { title: parsed.title ?? '', summary: parsed.summary ?? null, media: parsed.media ?? [] };
  } catch {
    return { title: '', summary: null, media: [] };
  }
}

/** HTML escape for every value that reaches `parse_mode: HTML` (§12.4). */
export function esc(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Telegram messages are 4096 characters [TG-MSG]; caption splitting with `(1/2)` lands in M5. */
export function clampMessage(text: string, limit = 4096): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(' ', limit - 1);
  return `${text.slice(0, cut > 0 ? cut : limit - 1)}…`;
}
