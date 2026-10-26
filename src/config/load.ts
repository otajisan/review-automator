import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../lib/errors.js';
import { ConfigSchema, SecretsSchema, type Config, type Secrets } from './schema.js';

export interface LoadedConfig {
  readonly config: Config;
  readonly secrets: Secrets;
  readonly configPath: string;
  readonly warnings: readonly string[];
}

export interface LoadOptions {
  readonly configPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env['XDG_CONFIG_HOME'];
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(home, '.config'), 'review-automator');
}

/** Expands a leading `~` so YAML authors can write paths the way they do in a shell. */
export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** Resolves every path-valued field once so the rest of the app never thinks about `~`. */
export function resolvePaths(config: Config, home = homedir()): Config {
  return {
    ...config,
    workspace: { ...config.workspace, dir: expandHome(config.workspace.dir, home) },
    state_dir: expandHome(config.state_dir, home),
  };
}

function formatZodIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `  ${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('\n');
}

export function parseConfig(yamlText: string, home = homedir()): Config {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError(`config.yaml is not valid YAML: ${(err as Error).message}`, { cause: err });
  }
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(`config.yaml is invalid:\n${formatZodIssues(result.error.issues)}`);
  }
  return resolvePaths(result.data, home);
}

export function parseSecrets(dotenvText: string, processEnv: NodeJS.ProcessEnv = {}): Secrets {
  const merged = { ...parseDotenv(dotenvText), ...pickSecretKeys(processEnv) };
  const result = SecretsSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(`secrets are invalid:\n${formatZodIssues(result.error.issues)}`);
  }
  return result.data;
}

function pickSecretKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const) {
    const v = env[key];
    if (v) out[key] = v;
  }
  return out;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`, { cause: err });
  }
}

/** The .env holds Slack tokens; anything looser than owner-only is worth a warning. */
async function permissionWarning(file: string): Promise<string | undefined> {
  try {
    const mode = (await stat(file)).mode & 0o777;
    if (mode & 0o077)
      return `${file} is readable by others (mode ${mode.toString(8)}); run: chmod 600 ${file}`;
  } catch {
    return undefined;
  }
  return undefined;
}

export async function loadConfig(opts: LoadOptions = {}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const dir = defaultConfigDir(env, home);
  const configPath = opts.configPath ?? env['REVIEW_AUTOMATOR_CONFIG'] ?? path.join(dir, 'config.yaml');
  const envPath = opts.envPath ?? env['REVIEW_AUTOMATOR_ENV'] ?? path.join(dir, '.env');

  const yamlText = await readOptional(configPath);
  if (yamlText === undefined) {
    throw new ConfigError(
      `config not found at ${configPath} (copy config.example.yaml there, or set REVIEW_AUTOMATOR_CONFIG)`,
    );
  }
  const config = parseConfig(yamlText, home);

  const dotenvText = (await readOptional(envPath)) ?? '';
  const secrets = parseSecrets(dotenvText, env);

  const warnings: string[] = [];
  const perm = await permissionWarning(envPath);
  if (perm) warnings.push(perm);

  return { config, secrets, configPath, warnings };
}
