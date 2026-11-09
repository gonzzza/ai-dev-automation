import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseLimit, scopeDir } from "../src/args.js";
import { checksEnv, findSecrets, isSecretFile, redactSecrets, secretValues } from "../src/secrets.js";

const env = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  GH_TOKEN: "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  NPM_CONFIG_AUTH: "short",
  DATABASE_URL: "postgres://app:hunter2hunter2@db:5432/app",
};

describe("checksEnv", () => {
  it("drops credentials, keeps the rest, and logs gh out", () => {
    const result = checksEnv(env, "/tmp/empty");
    expect(result).toMatchObject({ PATH: "/usr/bin", HOME: "/home/me", GH_CONFIG_DIR: "/tmp/empty", GIT_TERMINAL_PROMPT: "0" });
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("GH_TOKEN");
    expect(result).not.toHaveProperty("NPM_CONFIG_AUTH");
    expect(result).not.toHaveProperty("DATABASE_URL"); // an ordinary name: only an allowlist catches it
  });
});

describe("findSecrets", () => {
  it("finds known environment values and common credential formats", () => {
    const known = secretValues(env);
    expect(known).toEqual([env.ANTHROPIC_API_KEY, env.GH_TOKEN]);
    expect(findSecrets(`key=${env.GH_TOKEN}`, known)).toContain("a credential from the environment");
    expect(findSecrets("sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz", [])).toEqual(["Anthropic API key"]);
    expect(findSecrets("-----BEGIN RSA PRIVATE KEY-----", [])).toEqual(["private key"]);
    expect(findSecrets("url: postgres://app:hunter2@db/app", [])).toEqual(["URL with a password"]);
    expect(findSecrets("see https://github.com/o/r and git@github.com:o/r.git", [])).toEqual([]);
  });

  it("passes ordinary code and documentation placeholders", () => {
    expect(findSecrets('echo "ANTHROPIC_API_KEY=sk-ant-..." > .env', secretValues(env))).toEqual([]);
  });
});

describe("isSecretFile", () => {
  it("matches env files, private instructions and keys, but not .env.example", () => {
    for (const path of [".env", "a/.env.local", "CLAUDE.local.md", "certs/server.pem", ".npmrc"]) expect(isSecretFile(path)).toBe(true);
    for (const path of [".env.example", "src/env.ts", "README.md"]) expect(isSecretFile(path)).toBe(false);
  });
});

describe("parseLimit", () => {
  it("accepts positive numbers and rejects anything that would disable a cap", () => {
    expect(parseLimit("--max-budget", "2.5")).toBe(2.5);
    expect(parseLimit("--max-turns", "60", { integer: true })).toBe(60);
    for (const raw of ["", "ten", "5$", "0", "-1", "NaN", "Infinity"]) expect(() => parseLimit("--max-budget", raw)).toThrow("--max-budget");
    expect(() => parseLimit("--max-turns", "1.5", { integer: true })).toThrow("positive integer");
  });
});

describe("scopeDir", () => {
  const root = resolve("/repo");
  it("normalizes relative, trailing-slash and absolute forms to a repo-relative dir", () => {
    for (const dir of ["demo-app", "./demo-app", "demo-app/", resolve(root, "demo-app")]) expect(scopeDir(root, root, dir)).toBe("demo-app");
    expect(scopeDir(root, resolve(root, "agent"), "../demo-app/src")).toBe("demo-app/src");
  });

  it("rejects the repo root and paths outside the repo", () => {
    expect(() => scopeDir(root, root, ".")).toThrow("not the repository root");
    expect(() => scopeDir(root, root, "../elsewhere")).toThrow("outside the repository");
  });
});

describe("checksEnv git isolation", () => {
  it("cuts git off from global config, credential helpers and ssh, so test code can't push", () => {
    const result = checksEnv({ PATH: "/usr/bin" }, "/tmp/empty");
    expect(result).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.sshCommand",
      GIT_CONFIG_VALUE_1: "false",
    });
    expect(result.GIT_CONFIG_GLOBAL).toMatch(/^(NUL|\/dev\/null)$/);
  });
});

describe("redactSecrets", () => {
  it("replaces values from the environment and known credential formats, everywhere they occur", () => {
    const text = "a=sk-live-1234567890abcdef b=sk-live-1234567890abcdef c=ghp_abcdefghijklmnopqrstuvwxyz0123456789 d=postgres://u:pw123456@h/db";
    expect(redactSecrets(text, ["sk-live-1234567890abcdef"])).toBe("a=[REDACTED] b=[REDACTED] c=[REDACTED] d=[REDACTED]h/db");
  });

  it("replaces the longer of two overlapping values whole", () => {
    expect(redactSecrets("x=abcdefghijklmnop-extra", ["abcdefghijklmnop", "abcdefghijklmnop-extra"])).toBe("x=[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("refill resumes after the clock steps back", ["sk-live-1234567890abcdef"])).toBe("refill resumes after the clock steps back");
  });
});
