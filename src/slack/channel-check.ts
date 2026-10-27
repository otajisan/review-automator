/** Errors meaning "this token may not ask", not "something is wrong with the channel". */
const SCOPE_ERRORS = new Set(['missing_scope', 'not_allowed_token_type', 'no_permission']);

/** What `conversations.info` said about one channel: its `is_member`, or the API error code. */
export type ChannelProbe = { readonly id: string } & (
  { readonly isMember: boolean | undefined } | { readonly error: string }
);

export interface ChannelCheck {
  /** Definitely wrong; the setup check fails. */
  readonly problems: readonly string[];
  /** Cannot tell without extra scopes; a warning only. */
  readonly unverified: readonly string[];
}

export function classifyChannels(probes: readonly ChannelProbe[]): ChannelCheck {
  const problems: string[] = [];
  const unverified: string[] = [];
  for (const p of probes) {
    if ('error' in p) {
      if (SCOPE_ERRORS.has(p.error)) unverified.push(`${p.id} (${p.error})`);
      // Slack hides private channels the bot is not in behind channel_not_found.
      else if (p.error === 'channel_not_found')
        problems.push(`${p.id}: not found; check the ID, or invite the bot if it is a private channel`);
      else problems.push(`${p.id}: ${p.error}`);
    } else if (p.isMember === false) {
      problems.push(`${p.id}: bot is not a member; invite it`);
    } else if (p.isMember === undefined) {
      unverified.push(`${p.id} (membership not reported)`);
    }
  }
  return { problems, unverified };
}
