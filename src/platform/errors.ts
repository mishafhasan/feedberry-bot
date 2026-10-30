/** Error codes of ARCHITECTURE §11. One taxonomy for pipeline, platform and bot layers. */
export const E = {
  LINK_INVALID: 'E_LINK_INVALID',
  NO_FEED: 'E_NO_FEED',
  PROFILE_ONLY: 'E_PROFILE_ONLY',
  BOT_NOT_ADMIN: 'E_BOT_NOT_ADMIN',
  FORUM_TOPIC: 'E_FORUM_TOPIC',
  SOURCE_LIMIT: 'E_SOURCE_LIMIT',
  DUPLICATE: 'E_DUPLICATE',
  COOKIE_REQUIRED: 'E_COOKIE_REQUIRED',
  RATE_LIMIT: 'E_RATE_LIMIT',
  FEED_DOWN: 'E_FEED_DOWN',
  NO_MEDIA: 'E_NO_MEDIA',
  TOO_LARGE: 'E_TOO_LARGE',
  MEDIA_GONE: 'E_MEDIA_GONE',
  TELEGRAPH: 'E_TELEGRAPH',
  TG_PARSE: 'E_TG_PARSE',
  TG_FORBIDDEN: 'E_TG_FORBIDDEN',
  TG_429: 'E_TG_429',
  TG_UNKNOWN: 'E_TG_UNKNOWN',
  /** Download mode: a profile link was sent where a post link is required (ADR-013). */
  POST_REQUIRED: 'E_POST_REQUIRED',
  /** MAX_DOWNLOADS_PER_DAY reached (§12.4). */
  DOWNLOAD_LIMIT: 'E_DOWNLOAD_LIMIT',
} as const;

export type ErrorCode = (typeof E)[keyof typeof E];

/** A failure that already knows its user-facing code. */
export class Coded extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'Coded';
    this.code = code;
  }
}

export function isCoded(err: unknown): err is Coded {
  return err instanceof Coded;
}
