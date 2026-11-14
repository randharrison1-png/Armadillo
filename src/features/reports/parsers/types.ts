export type FindingStatus = 'pass' | 'fail' | 'unknown';

/** One audit finding. `rawLine` is the 1-based line of the finding in the report's raw text. */
export type Finding = {
  title: string;
  status: FindingStatus;
  severity?: string;
  category?: string;
  rawLine: number;
};

export type ParsedReport = {
  /** Id of the parser that produced the findings: 'generic', 'json', 'csv', ... or 'raw' (nothing could be parsed). */
  parser: string;
  /** The score the report itself states (points). Never computed by Armadillo and never a verification. */
  score: number | null;
  /** The maximum the report states for its score (the 100 in "84/100 points"), when it says one. */
  scoreMax?: number | null;
  findings: Finding[];
  /** More findings were present than MAX_FINDINGS; the rest are only in the raw text. */
  truncated?: boolean;
  /** A parser failed; the report is kept as raw text. */
  parseError?: string;
};

/**
 * A pluggable LEADS output parser. `detect` must be cheap and side-effect free; `parse` may throw
 * (parseLeadsReport catches it and keeps the report as raw text).
 */
export type LeadsParser = {
  id: string;
  detect(raw: string): boolean;
  parse(raw: string): ParsedReport;
};
