import { describe, expect, it } from "vitest";
import { parseLimit } from "../src/args.js";
import { checksEnv, findSecrets, isSecretFile, secretValues } from "../src/secrets.js";

const env = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  GH_TOKEN: "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  NPM_CONFIG_AUTH: "short",
};

describe("checksEnv", () => {
  it("drops credentials, keeps the rest, and logs gh out", () => {
    const result = checksEnv(env, "/tmp/empty");
    expect(result).toMatchObject({ PATH: "/usr/bin", HOME: "/home/me", GH_CONFIG_DIR: "/tmp/empty", GIT_TERMINAL_PROMPT: "0" });
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("GH_TOKEN");
    expect(result).not.toHaveProperty("NPM_CONFIG_AUTH");
  });
});

describe("findSecrets", () => {
  it("finds known environment values and common credential formats", () => {
    const known = secretValues(env);
    expect(known).toEqual([env.ANTHROPIC_API_KEY, env.GH_TOKEN]);
    expect(findSecrets(`key=${env.GH_TOKEN}`, known)).toContain("a credential from the environment");
    expect(findSecrets("sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz", [])).toEqual(["Anthropic API key"]);
    expect(findSecrets("-----BEGIN RSA PRIVATE KEY-----", [])).toEqual(["private key"]);
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
