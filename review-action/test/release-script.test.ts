import { describe, expect, it } from "vitest";
import { latestVersion, majorTag, nextVersion, parseLog, releaseNotes } from "../scripts/release.js";

describe("latestVersion", () => {
  it("picks the highest vX.Y.Z tag, comparing numerically", () => {
    expect(latestVersion(["v1.9.0", "v1.10.0", "v1.2.3"])).toBe("v1.10.0");
  });

  it("ignores the moving major tag and anything that isn't vX.Y.Z", () => {
    expect(latestVersion(["v1", "v2.0.0-rc.1", "release-3", "v1.0.0", ""])).toBe("v1.0.0");
  });

  it("returns undefined when there's no version tag yet", () => {
    expect(latestVersion(["v1"])).toBeUndefined();
  });
});

describe("nextVersion", () => {
  it("bumps one part and resets the lower ones", () => {
    expect(nextVersion("v1.2.3", "patch")).toBe("v1.2.4");
    expect(nextVersion("v1.2.3", "minor")).toBe("v1.3.0");
    expect(nextVersion("v1.2.3", "major")).toBe("v2.0.0");
  });

  it("rejects a tag that isn't vX.Y.Z", () => {
    expect(() => nextVersion("v1", "patch")).toThrow("not a vX.Y.Z version");
  });
});

describe("majorTag", () => {
  it("is the tag that @v1 references resolve to", () => {
    expect(majorTag("v1.4.2")).toBe("v1");
    expect(majorTag("v12.0.0")).toBe("v12");
  });
});

describe("parseLog", () => {
  it("splits git log's SHA<TAB>subject lines, skipping blank ones", () => {
    expect(parseLog("abc123\tFix a bug (#20)\n\ndef456\tSubject\twith a tab\n")).toEqual([
      { sha: "abc123", subject: "Fix a bug (#20)" },
      { sha: "def456", subject: "Subject\twith a tab" },
    ]);
  });
});

describe("releaseNotes", () => {
  const opts = { repoUrl: "https://github.com/o/r", previous: "v1.0.0", version: "v1.0.1" };

  it("lists each change, linking PRs by number and other commits by short SHA", () => {
    const notes = releaseNotes(
      [
        { sha: "a".repeat(40), subject: "Read inline comment ids from an endpoint that returns lines (#20)" },
        { sha: "b".repeat(40), subject: "Fix a typo in the bundle" },
      ],
      opts,
    );
    expect(notes).toContain("- Read inline comment ids from an endpoint that returns lines (#20)\n");
    expect(notes).toContain("- Fix a typo in the bundle (bbbbbbb)\n");
    expect(notes).toContain("**Full diff:** https://github.com/o/r/compare/v1.0.0...v1.0.1");
  });

  it("refuses to cut a release when the action hasn't changed", () => {
    expect(() => releaseNotes([], opts)).toThrow("Nothing to release");
  });
});
