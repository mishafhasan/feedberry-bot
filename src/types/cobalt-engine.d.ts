/**
 * cobalt-engine ships plain JavaScript (AGPL-3.0, vendored under /cobalt-engine and installed with
 * `file:`), so only the surface we call is declared here.
 */
declare module 'cobalt-engine' {
  export interface PickItem {
    type: string;
    url: string;
    thumb?: string;
  }

  export interface EngineResult {
    status: 'ok' | 'error';
    type?: string;
    filename?: string;
    urls?: string[];
    picker?: PickItem[];
    headers?: Record<string, string>;
    metadata?: { title?: string; artist?: string; publishedAt?: number };
    error?: { code: string };
  }

  export interface EngineDownload {
    status: 'ok' | 'error';
    files?: string[];
    muxed?: boolean;
    error?: { code: string };
  }

  export function resolve(
    input: string,
    options?: { signal?: AbortSignal; quality?: string; mode?: string; metadata?: boolean; generic?: boolean },
  ): Promise<EngineResult>;

  export function download(
    input: string | EngineResult,
    options?: { dir?: string; filename?: string; index?: number; signal?: AbortSignal; mux?: boolean; maxBytes?: number },
  ): Promise<EngineDownload>;

  export function hasFFmpeg(): boolean;
  export function sizeOf(files: string[]): Promise<number>;

  /** Seed the cookie pool in memory; no file is read or written. */
  export function setCookies(services: Record<string, string[]>): Record<string, unknown>;
}
