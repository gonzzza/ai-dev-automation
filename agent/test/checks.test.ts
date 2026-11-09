import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSandboxAvailable, DEFAULT_SANDBOX_IMAGE, runChecks, sandboxArgs } from "../src/checks.js";
import { exec, type Exec } from "../src/exec.js";
import { classifyFailure } from "../src/runlog.js";

const docker = { kind: "docker" as const, image: DEFAULT_SANDBOX_IMAGE, uid: 1001, gid: 118 };

describe("sandboxArgs", () => {
  const args = sandboxArgs("/repo", ["npm", "run", "check"], docker);

  it("cuts the network, drops privileges and caps resources", () => {
    expect(args).toEqual(expect.arrayContaining(["run", "--rm", "--init", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512"]));
  });

  it("mounts only the repo, with .git read-only, and runs as the host user", () => {
    expect(args.filter((a) => a.startsWith("--volume="))).toEqual(["--volume=/repo:/work", `--volume=${join("/repo", ".git")}:/work/.git:ro`]);
    expect(args).toEqual(expect.arrayContaining(["--user", "1001:118", "--workdir=/work"]));
  });

  it("passes no environment from this process, only fixed settings", () => {
    const envs = args.filter((a) => a.startsWith("--env") || a === "-e");
    expect(envs).toEqual(["--env=HOME=/tmp", "--env=CI=1", "--env=npm_config_cache=/tmp/.npm", "--env=npm_config_update_notifier=false"]);
  });

  it("ends with the image and the command", () => {
    expect(args.slice(-4)).toEqual([DEFAULT_SANDBOX_IMAGE, "npm", "run", "check"]);
  });

  it("omits --user where the host has no uid (Windows)", () => {
    expect(sandboxArgs("/repo", ["true"], { image: "img" })).not.toContain("--user");
  });
});

describe("runChecks", () => {
  const ok: Exec = vi.fn(async () => ({ code: 0, stdout: "all good", stderr: "" }));

  it("runs npm directly without a sandbox", async () => {
    expect(await runChecks(ok, "/repo", { PATH: "/bin" })).toEqual({ passed: true, output: "all good" });
    expect(ok).toHaveBeenLastCalledWith("npm", ["run", "check"], { cwd: "/repo", env: { PATH: "/bin" } });
  });

  it("runs the same command inside a uniquely named container, then removes that container", async () => {
    const calls: string[][] = [];
    const fake: Exec = async (_cmd, args) => (calls.push(args), { code: 0, stdout: "all good", stderr: "" });
    expect(await runChecks(fake, "/repo", { PATH: "/bin" }, docker)).toEqual({ passed: true, output: "all good" });

    const name = calls[0]!.find((a) => a.startsWith("--name="))!.slice("--name=".length);
    expect(name).toMatch(/^agent-checks-[0-9a-f]{12}$/);
    expect(calls[0]).toEqual(sandboxArgs("/repo", ["npm", "run", "check"], docker, name));
    expect(calls[1]).toEqual(["rm", "--force", name]);
  });

  it("removes the container even when the client was killed on a timeout, before returning", async () => {
    const calls: string[][] = [];
    const timedOut: Exec = async (_cmd, args) => (calls.push(args), args[0] === "run" ? { code: 1, stdout: "", stderr: "killed: timeout" } : { code: 0, stdout: "", stderr: "" });
    expect(await runChecks(timedOut, "/repo", {}, docker)).toMatchObject({ passed: false });
    expect(calls.map((a) => a[0])).toEqual(["run", "rm"]);
  });

  it("gives every run its own container name", async () => {
    const names = new Set<string>();
    const fake: Exec = async (_cmd, args) => {
      const n = args.find((a) => a.startsWith("--name="));
      if (n) names.add(n);
      return { code: 0, stdout: "", stderr: "" };
    };
    for (let i = 0; i < 3; i++) await runChecks(fake, "/repo", {}, docker);
    expect(names.size).toBe(3);
  });
});

describe("assertSandboxAvailable", () => {
  it("fails fast, as a config error, when docker isn't running", async () => {
    const down: Exec = async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\nmore" });
    const error = await assertSandboxAvailable(down, docker).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Docker is not available (Cannot connect to the Docker daemon)");
    expect(classifyFailure((error as Error).message)).toBe("config");
  });

  it("does nothing without a sandbox", async () => {
    const never: Exec = vi.fn();
    await assertSandboxAvailable(never, { kind: "none" });
    expect(never).not.toHaveBeenCalled();
  });
});

// The real thing: start the container and have the code inside try to escape. Runs wherever Docker
// is available (CI's Ubuntu runners have it); skipped otherwise, including inside the sandbox itself.
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(dockerAvailable)("the docker sandbox, for real", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("blocks the network, hides this process's environment and keeps .git read-only", { timeout: 300_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "sandbox-test-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "[core]\n");
    const probe = `
      const fs = require("fs");
      const out = { env: Object.keys(process.env) };
      for (const [name, path] of [["gitWrite", "/work/.git/config"], ["repoWrite", "/work/written.txt"]]) {
        try { fs.writeFileSync(path, "x"); out[name] = "ok"; } catch (e) { out[name] = e.code; }
      }
      fetch("http://1.1.1.1", { signal: AbortSignal.timeout(5000) })
        .then(() => (out.network = "reached"), () => (out.network = "blocked"))
        .finally(() => console.log(JSON.stringify(out)));
    `;
    const sandbox = { image: DEFAULT_SANDBOX_IMAGE, uid: process.getuid?.(), gid: process.getgid?.() };
    // The docker client gets a "secret"; the container must not.
    const result = await exec("docker", sandboxArgs(dir, ["node", "-e", probe], sandbox), {
      cwd: dir,
      env: { PATH: process.env.PATH, SANDBOX_TEST_TOKEN: "must-not-leak", HOME: process.env.HOME },
      timeoutMs: 280_000,
    });
    expect(result.code, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(out).toMatchObject({ network: "blocked", gitWrite: "EROFS", repoWrite: "ok" });
    expect(out.env).not.toContain("SANDBOX_TEST_TOKEN");
  });
});
