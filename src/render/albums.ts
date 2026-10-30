/** §8.3: `sendMediaGroup` takes 2–10 items, and mixed kinds are not allowed in one group. */
export const ALBUM_MAX = 10;

export function chunk<T>(items: T[], size = ALBUM_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
