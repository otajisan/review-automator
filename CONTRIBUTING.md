# Contributing

Thanks for helping out! Issues and pull requests are welcome.

## Development

```bash
pnpm install
pnpm test          # unit tests (vitest)
pnpm lint
pnpm typecheck
pnpm test:coverage # must stay above 80%
```

- Tests use fakes for Slack, `gh` and the Agent SDK; the workspace tests run real `git` against a
  local bare repository. No network access or tokens are needed.
- To try a real review without Slack: `pnpm review-once <PR URL>`. It prints what would be posted and
  posts nothing.

## Guidelines

- Keep everything that touches GitHub write APIs in `src/github/post-review.ts`, called only from
  `src/service.ts` after a button press by the configured owner. The review session must stay read-only.
- Never load `project` settings in the review session: the checkout is the PR head and is untrusted.
- Keep the decision of what to post (`src/review/decision.ts`) deterministic and out of the model.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:` …).
- Do not commit real configuration, tokens or channel IDs.
