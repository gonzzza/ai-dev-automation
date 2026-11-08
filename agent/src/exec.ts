import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

/**
 * Run a command without a shell, so arguments are never re-parsed. On Windows,
 * npm is a .cmd script and needs one, so only that case goes through the shell,
 * as a single command string built from fixed arguments in this codebase.
 */
export const exec: Exec = (command, args, { cwd, timeoutMs = 10 * 60_000 } = {}) =>
  new Promise((resolve) => {
    const shell = process.platform === "win32" && command === "npm";
    const [file, fileArgs] = shell ? [[command, ...args].join(" "), []] : [command, args];
    execFile(file, fileArgs, { cwd, timeout: timeoutMs, shell, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Like exec, but throws with the command's output when it exits non-zero. */
export async function run(execFn: Exec, command: string, args: string[], cwd?: string): Promise<string> {
  const result = await execFn(command, args, { cwd });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.code}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** Keep the end of long output, where test failures and summaries are. */
export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `[... ${text.length - maxChars} earlier characters omitted]\n${text.slice(-maxChars)}`;
}
