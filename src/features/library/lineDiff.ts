/**
 * Added / removed line counts between two texts (newline kind ignored), for the diff tab summary.
 * Myers' O((N+M)·D) edit distance on lines after trimming the common prefix and suffix; when the
 * texts differ by more than `maxEdits` lines it stops and returns `approximate: true` with the
 * untrimmed middle sizes (an upper bound), so huge rewrites stay cheap.
 */
export function lineDiffStats(a: string, b: string, maxEdits = 20_000): { added: number; removed: number; approximate: boolean } {
  const x = a.split(/\r\n|\r|\n/);
  const y = b.split(/\r\n|\r|\n/);
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const n = endX - start;
  const m = endY - start;
  if (n === 0 || m === 0) return { added: m, removed: n, approximate: false };
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let j = i - k;
      while (i < n && j < m && x[start + i] === y[start + j]) {
        i++;
        j++;
      }
      v[off + k] = i;
      if (i >= n && j >= m) return { added: (d + m - n) / 2, removed: (d + n - m) / 2, approximate: false };
    }
  }
  return { added: m, removed: n, approximate: true };
}
