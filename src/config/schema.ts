import { z } from 'zod';

const SlackId = z.string().regex(/^[A-Z][A-Z0-9]{6,}$/, 'expected a Slack ID such as U0123ABCD or C0123ABCD');

/** Tool permission rule as understood by Claude Code, e.g. `Bash(git diff *)`. */
const ToolRule = z.string().min(1);

export const PerRepoSchema = z.object({
  extra_skills: z.array(z.string().min(1)).default([]),
  allowed_tools: z.array(ToolRule).default([]),
  extra_instructions: z.string().default(''),
});

export const ConfigSchema = z.object({
  owner: z.object({
    slack_user_id: SlackId,
    github_login: z.string().min(1),
  }),
  slack: z.object({
    watch_channels: z.array(SlackId).min(1),
    notify_channel: SlackId,
    /** Who may trigger a review by posting a link. Empty means anyone in the watched channels. */
    allowed_requesters: z.array(SlackId).default([]),
  }),
  github: z.object({
    allowed_repos: z.array(z.string().min(1)).min(1),
    /** Draft PRs are not ready for review. */
    skip_drafts: z.boolean().default(true),
    /** Skip a PR whose current head the owner has already approved. */
    skip_approved_by_owner: z.boolean().default(true),
  }),
  workspace: z
    .object({
      dir: z.string().min(1).default('~/Library/Application Support/review-automator/workspace'),
      keep_worktree_on_failure: z.boolean().default(true),
    })
    .prefault({}),
  review: z
    .object({
      model: z.string().min(1).default('sonnet'),
      max_turns: z.number().int().positive().default(80),
      max_budget_usd: z.number().positive().default(3),
      timeout_minutes: z.number().positive().default(20),
      concurrency: z.number().int().positive().default(1),
      skill: z.string().min(1).default('review-automator:pr-review'),
      reviewers: z
        .array(z.string().min(1))
        .min(1)
        .default(['review-automator:correctness-reviewer', 'review-automator:security-reviewer']),
      verifier: z.string().min(1).default('review-automator:finding-verifier'),
      language: z.string().min(2).default('en'),
      env: z.record(z.string(), z.string()).default({}),
      /** Turn off hooks from ~/.claude settings and plugins inside the review session. */
      disable_user_hooks: z.boolean().default(true),
      per_repo: z.record(z.string(), PerRepoSchema).default({}),
    })
    .prefault({}),
  post: z
    .object({
      approve_body: z
        .string()
        .default('LGTM!! :+1:\n確認したほうが良さそうな箇所のみコメントしました！ご確認くださいませ。'),
      approve_body_no_findings: z.string().default('LGTM!! :+1:'),
      /** Body of a non-approving review that has no inline comments (e.g. your own PR). */
      comment_body_no_findings: z.string().default('確認しました。コメントは特にありません。'),
      comment_body: z
        .string()
        .default('確認したほうが良さそうな箇所にコメントしました！ご確認くださいませ。'),
      severity_on_findings: z.enum(['COMMENT', 'REQUEST_CHANGES']).default('COMMENT'),
    })
    .prefault({}),
  state_dir: z.string().min(1).default('~/Library/Application Support/review-automator'),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PerRepoConfig = z.infer<typeof PerRepoSchema>;

export const SecretsSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'SLACK_BOT_TOKEN must be a bot token (xoxb-...)'),
  SLACK_APP_TOKEN: z.string().startsWith('xapp-', 'SLACK_APP_TOKEN must be an app-level token (xapp-...)'),
});

export type Secrets = z.infer<typeof SecretsSchema>;
