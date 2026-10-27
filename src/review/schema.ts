import { z } from 'zod';

export const SEVERITIES = ['must_fix', 'should_fix', 'nit'] as const;
export const VERIFICATIONS = ['confirmed', 'refuted', 'uncertain', 'not_verified'] as const;

export const FindingSchema = z.object({
  id: z.string().min(1).describe('C1..Cn for correctness, S1..Sn for security, X1..Xn for extra skills'),
  file: z.string().min(1).describe('Repository-relative path in the PR head'),
  line: z.number().int().positive().describe('Line number in the PR head version of the file'),
  severity: z
    .enum(SEVERITIES)
    .describe('must_fix = fix before merge, should_fix = worth fixing, nit = optional'),
  confidence: z.enum(['high', 'medium', 'low']),
  verification: z
    .enum(VERIFICATIONS)
    .describe('Outcome of the verifier for must_fix findings; not_verified when verification was skipped'),
  title: z.string().min(1).max(200).describe('One-line summary'),
  body: z
    .string()
    .min(1)
    .describe('Review comment for the PR author: evidence, failure scenario, suggested fix. Markdown.'),
});

export const ReviewResultSchema = z.object({
  complete: z
    .boolean()
    .describe(
      'true only if every reviewer (and the verifier, when used) returned its report and you read it',
    ),
  incomplete_reason: z.string().optional().describe('Required when complete is false'),
  summary: z.string().describe('At most three lines summarising the PR and the review outcome'),
  findings: z.array(FindingSchema),
});

export type Finding = z.infer<typeof FindingSchema>;
export type Severity = Finding['severity'];
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** JSON Schema handed to the Agent SDK. The SDK validates with draft-07. */
export function reviewResultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ReviewResultSchema, { target: 'draft-7' });
}
