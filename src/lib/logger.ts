import pino from 'pino';

/** Tokens never reach the log even if a caller logs a whole config or request object. */
const REDACT_PATHS = [
  '*.token',
  '*.slackBotToken',
  '*.slackAppToken',
  'token',
  'authorization',
  '*.authorization',
];

export type Logger = pino.Logger;

/** `fd` 2 keeps logs off stdout for CLIs whose stdout is machine-readable output. */
export function createLogger(level: string = process.env['LOG_LEVEL'] ?? 'info', fd: 1 | 2 = 1): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, pino.destination(fd));
}
