import { z } from 'zod';
import type { ClaudeTool } from './client';

/**
 * Tool-use schemas for Claude's structured outputs (plan §6): each tool's JSON schema (what Claude
 * is asked to fill in) next to the Zod schema that validates what came back. The tools only RECORD
 * Claude's answer; they never read data (Claude gets no tools that reach the database or files).
 *
 * Validation is strict about shape (an invalid answer triggers the one automatic retry), but not
 * about references into our data: a segment id that does not exist or a requirement key Claude
 * made up is dropped and counted by the caller, not retried.
 */

export const REQUIREMENT_CATEGORIES = [
  'accounts',
  'passwords',
  'services',
  'firewall',
  'remote_access',
  'updates',
  'software',
  'files',
  'policies',
  'auditing',
  'forensics',
  'other',
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export const MAX_EXTRACTED = 300;
export const REQUIREMENT_TEXT_MAX = 1000;
export const SUGGESTION_MAX = 2000;

// ------------------------------------------------------------------------------------------------
// Extraction
// ------------------------------------------------------------------------------------------------

export const EXTRACT_TOOL: ClaudeTool = {
  name: 'record_requirements',
  description:
    'Records the hardening requirements found in the README. Call it exactly once with every requirement. It only records your answer.',
  input_schema: {
    type: 'object',
    properties: {
      requirements: {
        type: 'array',
        maxItems: MAX_EXTRACTED,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The requirement as one short imperative sentence, e.g. "Disable the guest account".' },
            segment_id: { type: 'string', description: 'The id from the README segment marker the requirement comes from (the part after the code, e.g. "p-3-1a2b3c4d" or "page-2").' },
            category: { type: 'string', enum: [...REQUIREMENT_CATEGORIES] },
            automatable: { type: 'boolean', description: 'False when a script cannot safely do it (judgement calls, forensic questions, anything needing a person).' },
            disruptive: { type: 'boolean', description: 'True when doing it could break the machine or lock the operator out (accounts, services, firewall, remote access).' },
          },
          required: ['text', 'segment_id', 'category', 'automatable', 'disruptive'],
        },
      },
    },
    required: ['requirements'],
  },
};

export const ExtractedRequirementSchema = z.object({
  text: z.string().trim().min(1).max(REQUIREMENT_TEXT_MAX),
  // Not required to exist here: unknown or empty ids are dropped and counted, not retried.
  segment_id: z.string().trim().max(200),
  category: z.enum(REQUIREMENT_CATEGORIES),
  automatable: z.boolean(),
  disruptive: z.boolean(),
});
export type ExtractedRequirement = z.infer<typeof ExtractedRequirementSchema>;

export const ExtractionSchema = z.object({ requirements: z.array(ExtractedRequirementSchema).max(MAX_EXTRACTED) });
export type Extraction = z.infer<typeof ExtractionSchema>;

// ------------------------------------------------------------------------------------------------
// Coverage assessment
// ------------------------------------------------------------------------------------------------

/** Claude's coverage verdict. Disruptiveness is a separate, sticky flag (never a coverage value). */
export const ASSESSED_COVERAGE = ['covered', 'missing', 'manual'] as const;
export type AssessedCoverage = (typeof ASSESSED_COVERAGE)[number];

export const ASSESS_TOOL: ClaudeTool = {
  name: 'record_coverage',
  description:
    'Records, for each listed requirement, whether the selected script already handles it. Call it exactly once. It only records your answer.',
  input_schema: {
    type: 'object',
    properties: {
      assessments: {
        type: 'array',
        maxItems: MAX_EXTRACTED,
        items: {
          type: 'object',
          properties: {
            requirement_id: { type: 'string', description: 'The key of a listed requirement, e.g. R3.' },
            coverage: {
              type: 'string',
              enum: [...ASSESSED_COVERAGE],
              description: 'covered: the script already does it. missing: the script does not do it. manual: it cannot safely be automated.',
            },
            suggestion: { type: 'string', description: 'For missing: the change to make to the script. For a disruptive requirement: what a person should review. Brief.' },
            disruptive: { type: 'boolean', description: 'True when doing it, or what the script does about it, could stop a required service or lock the operator out.' },
            automatable: { type: 'boolean' },
          },
          required: ['requirement_id', 'coverage', 'disruptive', 'automatable'],
        },
      },
    },
    required: ['assessments'],
  },
};

export const AssessmentItemSchema = z.object({
  requirement_id: z.string().trim().max(100),
  coverage: z.enum(ASSESSED_COVERAGE),
  suggestion: z.string().trim().max(SUGGESTION_MAX).nullish(),
  disruptive: z.boolean(),
  automatable: z.boolean(),
});
export type AssessmentItem = z.infer<typeof AssessmentItemSchema>;

export const AssessmentSchema = z.object({ assessments: z.array(AssessmentItemSchema).max(MAX_EXTRACTED) });
export type Assessment = z.infer<typeof AssessmentSchema>;

// ------------------------------------------------------------------------------------------------
// Script adaptation (Task 14)
// ------------------------------------------------------------------------------------------------

/** Categories Claude may give a flag (HighImpactCategory). */
export const FLAG_CATEGORIES = ['accounts', 'services', 'firewall', 'remote_access', 'other'] as const;
export const MAX_ADAPT_FLAGS = 300;
export const ADAPT_SUMMARY_MAX = 4000;
export const FLAG_REASON_MAX = 500;

export const ADAPT_TOOL: ClaudeTool = {
  name: 'record_adaptation',
  description:
    'Records the adapted script (complete), a summary of the changes, and every high-impact line of the adapted script. Call it exactly once. It only records your answer; nothing is saved until the user reviews and accepts it.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The COMPLETE adapted script, every line, ready to save as the file. Not a diff or an excerpt; no Markdown code fences around it.',
      },
      summary: {
        type: 'string',
        description: 'First line: what changed, in one short sentence (it becomes the change note). Then any detail a reviewer needs, including README requirements left for a person to do.',
      },
      flags: {
        type: 'array',
        maxItems: MAX_ADAPT_FLAGS,
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: [...FLAG_CATEGORIES] },
            line: { type: 'integer', minimum: 1, description: '1-based line number in the adapted script (content).' },
            reason: { type: 'string', description: 'What the line could break or who it could lock out, briefly.' },
          },
          required: ['category', 'line', 'reason'],
        },
      },
    },
    required: ['content', 'summary', 'flags'],
  },
};

const clipped = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

export const AdaptationSchema = z.object({
  content: z.string().min(1),
  summary: clipped(ADAPT_SUMMARY_MAX).pipe(z.string().min(1)),
  // `line` is not required to be an integer inside the file here: wrong lines are dropped and
  // counted by the caller (resolveClaudeFlags), not retried.
  flags: z.array(z.object({ category: z.enum(FLAG_CATEGORIES), line: z.number(), reason: clipped(FLAG_REASON_MAX) })).max(MAX_ADAPT_FLAGS),
});
export type Adaptation = z.infer<typeof AdaptationSchema>;
