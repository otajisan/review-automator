import type { SlackPort } from '../../src/slack/port.js';

export interface SlackCall {
  readonly method: keyof SlackPort;
  readonly args: Record<string, unknown>;
}

export function fakeSlack(): SlackPort & {
  calls: SlackCall[];
  of(method: keyof SlackPort): Record<string, unknown>[];
  /** Text of the first message of each thread, by thread ts. */
  threadParents: Record<string, string>;
} {
  const calls: SlackCall[] = [];
  const threadParents: Record<string, string> = {};
  let ts = 1000;
  const record = (method: keyof SlackPort, args: object) => calls.push({ method, args: { ...args } });
  return {
    calls,
    threadParents,
    of: (method) => calls.filter((c) => c.method === method).map((c) => c.args),
    postMessage: (args) => {
      record('postMessage', args);
      ts += 1;
      return Promise.resolve({ ts: `${ts}.000` });
    },
    updateMessage: (args) => {
      record('updateMessage', args);
      return Promise.resolve();
    },
    postEphemeral: (args) => {
      record('postEphemeral', args);
      return Promise.resolve();
    },
    addReaction: (args) => {
      record('addReaction', args);
      return Promise.resolve();
    },
    removeReaction: (args) => {
      record('removeReaction', args);
      return Promise.resolve();
    },
    permalink: (args) => {
      record('permalink', args);
      return Promise.resolve('https://slack.example/archives/C/p1');
    },
    threadParentText: (args) => {
      record('threadParentText', args);
      return Promise.resolve(threadParents[args.threadTs]);
    },
  };
}
