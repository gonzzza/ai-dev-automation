/** Environment variable names that hold credentials. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Files the agent must never read: local env files, private instructions, keys. `.env.example` is fine. */
const SECRET_FILE = /^(\.env(\.(?!example$).+)?|CLAUDE\.local\.md|\.npmrc|.*\.(pem|key|p12|pfx))$/i;

/** Credential formats worth catching even when the value isn't in this process's environment. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function isSecretFile(path: string): boolean {
  return SECRET_FILE.test(path.split(/[\\/]/).pop() ?? "");
}

/** Values of credential-looking variables in `env`, for leak scanning. Short values are ignored as too noisy. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length >= 12)
    .map(([, value]) => value!);
}

/**
 * The environment for `npm run check`, which runs code the agent wrote. Credentials are removed,
 * and gh is pointed at an empty config dir so it is logged out. This narrows what that code can
 * reach; it is not a sandbox, which is why untrusted specs should run in a disposable container.
 */
export function checksEnv(env: NodeJS.ProcessEnv, emptyDir: string): NodeJS.ProcessEnv {
  const scrubbed = Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)));
  return { ...scrubbed, GH_CONFIG_DIR: emptyDir, GIT_TERMINAL_PROMPT: "0" };
}

/** Names of the secrets found in `text`: known values from the environment, or well-known credential formats. */
export function findSecrets(text: string, knownValues: string[]): string[] {
  const found = knownValues.some((value) => text.includes(value)) ? ["a credential from the environment"] : [];
  for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) found.push(name);
  return found;
}
