import { Coded, E } from '../platform/errors.ts';
import { detectSource, type DetectOptions, type SourceRef } from '../platform/registry.ts';

/**
 * Stage 1 for the add-source flow. A post link is a valid `SourceRef` for Download Mode (ADR-013)
 * but is not a source, so it is refused here until M5 gives that flow its own entry point.
 */
export function resolveProfile(link: string, opts: DetectOptions): SourceRef {
  const ref = detectSource(link, opts);
  if (ref.strategy === 'single_post') throw new Coded(E.LINK_INVALID, 'post link, not a profile');
  return ref;
}
