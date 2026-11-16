import { scoreFromLine, splitLines, type Score } from './shared';

/** The report's own score: the LAST line that states one (totals come last), or null. */
export function extractScore(raw: string): Score | null {
  let found: Score | null = null;
  for (const line of splitLines(raw)) {
    const s = scoreFromLine(line);
    if (s) found = s;
  }
  return found;
}
