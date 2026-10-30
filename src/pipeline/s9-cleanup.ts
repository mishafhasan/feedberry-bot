import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Stage 9: every job gets one directory, deleted on success and on every error path (§5.1). */
export function workDirFor(key: string): string {
  return join(tmpdir(), 'feedberry-media', key);
}

export async function cleanupWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
