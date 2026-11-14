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

export const ASSESSED_COVERAGE = ['covered', 'missing', 'needs_review', 'manual'] as const;
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
              description:
                'covered: the script already does it. missing: the script does not do it. needs_review: doing it (or what the script does about it) is potentially disruptive. manual: it cannot safely be automated.',
            },
            suggestion: { type: 'string', description: 'For missing or needs_review: the change to make to the script, briefly.' },
            disruptive: { type: 'boolean' },
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
