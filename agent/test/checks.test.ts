import { execFileSync } from "node:child_process";
import { execFileSync as run } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSandboxAvailable, DEFAULT_SANDBOX_IMAGE, depsVolumeName, installArgs, prepareSandbox, runChecks, sandboxArgs } from "../src/checks.js";
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

  it("mounts the platform's dependencies read-only over node_modules, when prepared", () => {
    const withDeps = sandboxArgs("/repo", ["true"], { ...docker, depsVolume: "deps-1" });
    expect(withDeps).toContain("--volume=deps-1:/work/node_modules:ro");
    expect(args.some((a) => a.includes("/work/node_modules"))).toBe(false);
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

describe("the dependency volume", () => {
  it("is named after the lockfile and image, so either changing means a fresh install", () => {
    const name = depsVolumeName("lock-a", "node:24");
    expect(name).toMatch(/^ai-dev-automation-deps-[0-9a-f]{16}$/);
    expect(depsVolumeName("lock-a", "node:24")).toBe(name);
    expect(depsVolumeName("lock-b", "node:24")).not.toBe(name);
    expect(depsVolumeName("lock-a", "node:26")).not.toBe(name);
  });

  it("installs with the repo read-only and no secrets, then hands the files to the host user", () => {
    const args = installArgs("/repo", "deps-1", docker);
    expect(args).toEqual(expect.arrayContaining(["--volume=/repo:/src:ro", "--volume=deps-1:/deps", "--cap-drop=ALL", "--security-opt=no-new-privileges"]));
    expect(args.filter((a) => a.startsWith("--env="))).toEqual(["--env=HOME=/tmp", "--env=npm_config_cache=/tmp/.npm", "--env=npm_config_update_notifier=false"]);
    const script = args.at(-1)!;
    expect(script).toContain("npm ci");
    expect(script).toContain("find . -name package.json -not -path '*/node_modules/*'"); // globbed workspaces too
    expect(script).toContain("supports dependencies in the root node_modules only");
    expect(script).toContain("chown -R 1001:118 /deps");
    expect(script.trimEnd().split("\n").at(-1)).toBe("touch /deps/.ai-dev-automation-installed"); // marker last
  });

  it("installs only when the volume isn't complete yet, and attaches it to the sandbox", async () => {
    const calls: string[][] = [];
    const fresh: Exec = async (_cmd, args) => (calls.push(args), { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" });
    const prepared = await prepareSandbox(fresh, "/repo", docker, { log: () => {}, readLockfile: async () => "lock" });
    expect(prepared).toEqual({ ...docker, depsVolume: depsVolumeName("lock", docker.image) });
    // Created (labeled) before anything mounts it, then probed, then installed into.
    expect(calls.map((a) => a.slice(0, 2).join(" "))).toEqual(["volume create", "run --rm", "run --rm"]);
    expect(calls[0]).toContain("--label=ai-dev-automation.deps");

    const again: string[][] = [];
    const ready: Exec = async (_cmd, args) => (again.push(args), { code: 0, stdout: "", stderr: "" });
    await prepareSandbox(ready, "/repo", docker, { log: () => {}, readLockfile: async () => "lock" });
    expect(again.map((a) => a[0])).toEqual(["volume", "run"]); // create (a no-op) and the marker check, no install
  });

  it("fails the run before the agent starts if the install fails", async () => {
    const broken: Exec = async (_cmd, args) => (args.includes("sh") ? { code: 1, stdout: "", stderr: "npm error 404" } : { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" });
    await expect(prepareSandbox(broken, "/repo", docker, { log: () => {}, readLockfile: async () => "lock" })).rejects.toThrow(/installing dependencies failed:\n.*npm error 404/s);
  });

  it("does nothing without a sandbox", async () => {
    const never: Exec = vi.fn();
    expect(await prepareSandbox(never, "/repo", { kind: "none" }, { log: () => {}, readLockfile: async () => "" })).toEqual({ kind: "none" });
    expect(never).not.toHaveBeenCalled();
  });
});

describe.runIf(dockerAvailable)("the dependency volume, for real", () => {
  let dir: string;
  let volume: string | undefined;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (volume) run("docker", ["volume", "rm", "--force", volume], { stdio: "ignore" });
  });

  it("installs a workspace project into a labeled volume that the sandbox can use but not change", { timeout: 300_000 }, async () => {
    // A tiny npm workspace with no registry packages, so the install needs no network. The workspace
    // is declared as a glob, the common form, and npm ci links it into node_modules.
    dir = mkdtempSync(join(tmpdir(), "sandbox-deps-"));
    const name = `t${Date.now()}`; // a lockfile of its own, so a volume of its own
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "packages", "pkg"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", private: true, workspaces: ["packages/*"] }));
    writeFileSync(join(dir, "packages", "pkg", "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(dir, "packages", "pkg", "index.js"), "module.exports = 42;\n");
    const lockfile = JSON.stringify({
      name,
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name, version: "1.0.0", workspaces: ["packages/*"] },
        "node_modules/pkg": { resolved: "packages/pkg", link: true },
        "packages/pkg": { version: "1.0.0" },
      },
    });
    writeFileSync(join(dir, "package-lock.json"), lockfile);

    const base = { kind: "docker" as const, image: DEFAULT_SANDBOX_IMAGE, uid: process.getuid?.(), gid: process.getgid?.() };
    const prepared = await prepareSandbox(exec, dir, base, { log: () => {}, readLockfile: async () => lockfile });
    volume = prepared.kind === "docker" ? prepared.depsVolume : undefined;
    expect(volume).toBe(depsVolumeName(lockfile, DEFAULT_SANDBOX_IMAGE));

    const labels = run("docker", ["volume", "inspect", "--format", "{{json .Labels}}", volume!], { encoding: "utf8" });
    expect(JSON.parse(labels)).toHaveProperty("ai-dev-automation.deps");

    const probe = `
      const fs = require("fs");
      const out = { pkg: require("pkg") };
      try { fs.writeFileSync("/work/node_modules/planted.js", "x"); out.depsWrite = "ok"; } catch (e) { out.depsWrite = e.code; }
      fs.writeFileSync("/tmp/helper.sh", "#!/bin/sh\\necho ran");
      fs.chmodSync("/tmp/helper.sh", 0o755);
      out.tmpExec = require("child_process").execFileSync("/tmp/helper.sh", { encoding: "utf8" }).trim();
      console.log(JSON.stringify(out));
    `;
    const result = await exec("docker", sandboxArgs(dir, ["node", "-e", probe], prepared.kind === "docker" ? prepared : base), { cwd: dir, timeoutMs: 120_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ pkg: 42, depsWrite: "EROFS", tmpExec: "ran" });
  });
});
