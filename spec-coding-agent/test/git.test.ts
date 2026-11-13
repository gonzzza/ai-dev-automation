import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/exec.js";
import { fingerprintConfig, Git, parsePorcelainZ } from "../src/git.js";

describe("parsePorcelainZ", () => {
  it("keeps the first character of paths whose status starts with a space", () => {
    expect(parsePorcelainZ(" M demo-app/README.md\0?? demo-app/src/new.ts\0")).toEqual([
      "demo-app/README.md",
      "demo-app/src/new.ts",
    ]);
  });

  it("returns both paths of a rename, since the source is deleted and must pass the scope gate too", () => {
    expect(parsePorcelainZ("R  demo-app/x.yml\0.github/workflows/ci.yml\0 M demo-app/c.ts\0")).toEqual([
      "demo-app/x.yml",
      ".github/workflows/ci.yml",
      "demo-app/c.ts",
    ]);
  });

  it("handles spaces in paths and empty output", () => {
    expect(parsePorcelainZ("?? demo-app/my file.ts\0")).toEqual(["demo-app/my file.ts"]);
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

describe("fingerprintConfig", () => {
  const list = (...entries: string[]) => entries.map((entry) => `${entry}\0`).join("");

  it("drops only VS Code's merge-base keys and keeps every other entry in order", () => {
    const input = list(
      "core.bare\nfalse",
      "branch.main.vscode-merge-base\norigin/main",
      "branch.main.remote\norigin",
      "branch.agent/x.vscode-merge-base\norigin/main",
      "core.hookspath\n/tmp/planted",
    );
    expect(fingerprintConfig(input)).toBe(["core.bare\nfalse", "branch.main.remote\norigin", "core.hookspath\n/tmp/planted"].join("\0"));
  });

  it("does not drop keys that only contain the inert name", () => {
    const input = list("core.vscode-merge-base\nx", "branch.main.vscode-merge-base.extra\nx");
    expect(fingerprintConfig(input)).toBe(["core.vscode-merge-base\nx", "branch.main.vscode-merge-base.extra\nx"].join("\0"));
  });
});

describe("Git review threads", () => {
  /** A fake gh that records each call; `--input` files are read before Git deletes them. */
  function fakeGh(stdout: (args: string[]) => string = () => "") {
    const calls: { args: string[]; input?: string }[] = [];
    const exec: Exec = vi.fn(async (_command: string, args: string[]) => {
      const i = args.indexOf("--input");
      calls.push({ args, ...(i === -1 ? {} : { input: await readFile(args[i + 1]!, "utf8") }) });
      return { code: 0, stdout: stdout(args), stderr: "" };
    });
    return { git: new Git(exec, "/repo"), calls };
  }

  it("replies through the replies endpoint with the body as JSON", async () => {
    const { git, calls } = fakeGh();
    const body = 'Fixed in `abc`; "quoted"\n$(not run)';
    await git.replyToReviewComment(5, 1234, body);
    expect(calls[0]!.args.slice(0, 4)).toEqual(["api", "--method", "POST", "repos/{owner}/{repo}/pulls/5/comments/1234/replies"]);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ body });
  });

  it("finds the thread that starts with the comment and resolves it", async () => {
    const { git, calls } = fakeGh((args) => (args.some((a) => a.startsWith("query=query")) ? "PRRT_abc\n" : ""));
    await git.resolveReviewThread(5, 1234);
    expect(calls[0]!.args).toContain("number=5");
    expect(calls[0]!.args.at(-1)).toContain("databaseId == 1234");
    expect(calls[1]!.args).toContain("id=PRRT_abc");
    expect(calls[1]!.args.at(-1)).toContain("resolveReviewThread");
  });

  it("fails when no thread starts with the comment", async () => {
    const { git, calls } = fakeGh();
    await expect(git.resolveReviewThread(5, 1234)).rejects.toThrow("No review thread starts with comment 1234");
    expect(calls).toHaveLength(1);
  });
});

describe("Git claim and push", () => {
  const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
  function fakeGit(answer: (args: string[]) => { code: number; stdout: string; stderr?: string }) {
    const calls: string[][] = [];
    const exec: Exec = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const { code, stdout, stderr = "" } = answer(args);
      return { code, stdout, stderr };
    });
    return { git: new Git(exec, "/repo"), calls };
  }
  const created = "To ../origin.git\n*\trefs/heads/agent/x:refs/heads/agent/x\t[new branch]\nDone";

  it("AC2: claimBranch runs the lease push that only creates, and push has no -u", async () => {
    const { git, calls } = fakeGit((args) => ({ code: 0, stdout: args.includes("--porcelain") ? created : "" }));
    await git.claimBranch("agent/x");
    await git.push("agent/x");
    expect(calls).toEqual([
      [...SAFE, "push", "--porcelain", "--no-verify", "--force-with-lease=agent/x:", "origin", "agent/x"],
      [...SAFE, "push", "--no-verify", "origin", "agent/x"],
    ]);
  });

  it("AC2: claimBranch fails when git reports the branch already up to date on origin, which skips the lease", async () => {
    const { git } = fakeGit(() => ({ code: 0, stdout: "To ../origin.git\n=\trefs/heads/agent/x:refs/heads/agent/x\t[up to date]\nDone" }));
    await expect(git.claimBranch("agent/x")).rejects.toThrow(/did not create agent\/x on origin/);
  });

  it("AC2: claimBranch fails with git's output when the lease rejects the push", async () => {
    const { git } = fakeGit(() => ({ code: 1, stdout: "", stderr: "! refs/heads/agent/x:refs/heads/agent/x [rejected] (stale info)" }));
    await expect(git.claimBranch("agent/x")).rejects.toThrow(/stale info/);
  });

  it("branchExistsOnOrigin matches the ref exactly, and throws when ls-remote fails", async () => {
    const listed = fakeGit(() => ({ code: 0, stdout: "abc\trefs/heads/agent/x-old\ndef\trefs/heads/agent/x\n" }));
    expect(await listed.git.branchExistsOnOrigin("agent/x")).toBe(true);
    expect(listed.calls[0]).toEqual([...SAFE, "ls-remote", "--heads", "origin", "refs/heads/agent/x"]);
    const suffix = fakeGit(() => ({ code: 0, stdout: "abc\trefs/heads/agent/x-old\n" }));
    expect(await suffix.git.branchExistsOnOrigin("agent/x")).toBe(false);
    const offline = fakeGit(() => ({ code: 128, stdout: "", stderr: "fatal: unable to access" }));
    await expect(offline.git.branchExistsOnOrigin("agent/x")).rejects.toThrow(/unable to access/);
  });

  it("branchExists still reads an unreachable origin as no branch, and leaves the failure to the claim", async () => {
    const { git } = fakeGit((args) => (args.includes("rev-parse") ? { code: 1, stdout: "" } : { code: 128, stdout: "", stderr: "fatal" }));
    expect(await git.branchExists("agent/x")).toBe(false);
  });

  it("AC1: headOnBase maps merge-base --is-ancestor's 0 and 1, and throws on anything else", async () => {
    for (const [code, expected] of [[0, true], [1, false]] as const) {
      const { git, calls } = fakeGit(() => ({ code, stdout: "" }));
      expect(await git.headOnBase("main")).toBe(expected);
      expect(calls[0]).toEqual([...SAFE, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]);
    }
    const { git } = fakeGit(() => ({ code: 128, stdout: "", stderr: "fatal: Not a valid object name refs/remotes/origin/main" }));
    await expect(git.headOnBase("main")).rejects.toThrow(/Not a valid object name/);
  });
});
