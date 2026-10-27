/**
 * Last line of defence before text is posted under the owner's account: if a prompt-injected
 * review managed to copy a credential into a comment, refuse to post it.
 */
const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})/],
  ['GitLab token', /glpat-[A-Za-z0-9_-]{20}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['OpenAI/Anthropic-style key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/],
  ['Stripe live key', /\bsk_live_[0-9A-Za-z]{20,}/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Slack app token', /\bxapp-[A-Za-z0-9-]{10,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ['credentials in URL', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i],
];

/** Names of the secret kinds found in `text`; empty when it looks clean. */
export function findSecretLike(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Replaces anything secret-like with a placeholder. Used for every model-written string sent to Slack. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, [, re]) =>
      acc.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[redacted]'),
    text,
  );
}
