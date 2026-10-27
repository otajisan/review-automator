/** Base class so callers can distinguish our failures from unexpected ones. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid or missing configuration. Fatal at startup. */
export class ConfigError extends AppError {}

/** A review could not be produced. `kind` is shown to the requester in Slack. */
export class ReviewError extends AppError {
  constructor(
    readonly kind:
      | 'repo_not_allowed'
      | 'pr_not_open'
      | 'workspace'
      | 'engine_init'
      | 'engine_failed'
      | 'timeout'
      | 'budget',
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

/** Posting to GitHub failed after the user pressed a button. */
export class PostError extends AppError {}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
