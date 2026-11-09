import { describe, expect, it } from "vitest";
import { bundledPackageDirs, renderNotices, type PackageFiles } from "../scripts/build.js";

/** An in-memory package tree: path → file contents. Directory listings are derived from the paths. */
function fakeFiles(tree: Record<string, string>): PackageFiles {
  return {
    readFile: (path) => {
      const content = tree[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readdir: (dir) =>
      Object.keys(tree)
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map((path) => path.slice(dir.length + 1)),
  };
}

describe("bundledPackageDirs", () => {
  it("maps bundled files to their package directories, once each", () => {
    expect(
      bundledPackageDirs([
        "../node_modules/zod/v4/core/core.js",
        "../node_modules/zod/v4/classic/schemas.js",
        "../node_modules/@actions/core/lib/core.js",
      ]),
    ).toEqual(["../node_modules/zod", "../node_modules/@actions/core"]);
  });

  it("uses the innermost package for nested node_modules", () => {
    expect(bundledPackageDirs(["../node_modules/@actions/github/node_modules/@actions/http-client/lib/index.js"])).toEqual([
      "../node_modules/@actions/github/node_modules/@actions/http-client",
    ]);
  });

  it("skips this repo's own code, which the repo's LICENSE covers", () => {
    expect(bundledPackageDirs(["src/main.ts", "../standards/src/index.ts"])).toEqual([]);
  });

  it("accepts Windows path separators", () => {
    expect(bundledPackageDirs(["..\\node_modules\\undici\\index.js"])).toEqual(["../node_modules/undici"]);
  });
});

describe("renderNotices", () => {
  it("includes each package's license files, sorted by package name", () => {
    const files = fakeFiles({
      "nm/zod/package.json": JSON.stringify({ name: "zod", version: "4.0.0", license: "MIT" }),
      "nm/zod/LICENSE": "MIT License\r\n\r\nCopyright (c) Colin McDonnell\r\n",
      "nm/sdk/package.json": JSON.stringify({ name: "@anthropic-ai/sdk", version: "1.0.0", license: "Apache-2.0" }),
      "nm/sdk/LICENSE": "Apache License",
      "nm/sdk/NOTICE": "Copyright Anthropic",
      "nm/sdk/README.md": "not a license",
    });

    const notices = renderNotices(["nm/zod", "nm/sdk"], files);

    expect(notices.indexOf("@anthropic-ai/sdk@1.0.0 (Apache-2.0)")).toBeLessThan(notices.indexOf("zod@4.0.0 (MIT)"));
    expect(notices).toContain("Apache License\n\nCopyright Anthropic");
    expect(notices).toContain("MIT License\n\nCopyright (c) Colin McDonnell");
    expect(notices).not.toContain("\r");
    expect(notices).not.toContain("not a license");
  });

  it("lists the same package version once when it is installed in two places", () => {
    const pkg = JSON.stringify({ name: "tunnel", version: "0.0.6", license: "MIT" });
    const files = fakeFiles({ "a/tunnel/package.json": pkg, "a/tunnel/LICENSE": "MIT", "b/tunnel/package.json": pkg, "b/tunnel/LICENSE": "MIT" });

    expect(renderNotices(["a/tunnel", "b/tunnel"], files).match(/tunnel@0\.0\.6/g)).toHaveLength(1);
  });

  it("falls back to the declared license and repository when a package ships no license file", () => {
    const files = fakeFiles({
      "nm/hooks/package.json": JSON.stringify({ name: "hooks", version: "1.1.1", license: "MIT", repository: { url: "https://github.com/acme/hooks" } }),
    });

    expect(renderNotices(["nm/hooks"], files)).toContain(
      "hooks@1.1.1 (MIT)\n\nThe package ships no license file. Source: https://github.com/acme/hooks",
    );
  });

  it("refuses a package that states no license at all", () => {
    const files = fakeFiles({ "nm/mystery/package.json": JSON.stringify({ name: "mystery", version: "0.1.0" }) });

    expect(() => renderNotices(["nm/mystery"], files)).toThrow("mystery@0.1.0 states no license");
  });
});
