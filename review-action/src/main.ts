import * as core from "@actions/core";
import * as github from "@actions/github";
import Anthropic from "@anthropic-ai/sdk";
import { run, type PullRequestPayload } from "./run.js";

// Entry point: wire the real GitHub and Anthropic clients into run().
run({
  io: core,
  repo: github.context.repo,
  pullRequest: github.context.payload.pull_request as PullRequestPayload | undefined,
  createOctokit: (token) => github.getOctokit(token),
  createAnthropic: (apiKey) => new Anthropic({ apiKey }),
}).catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
