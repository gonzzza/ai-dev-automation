import { describe, expect, it } from "vitest";
import { StandardsError } from "../src/index.js";

describe("StandardsError", () => {
  it("is an Error with its own name", () => {
    const error = new StandardsError("org-standards/ts/ts-001.md:2: id is required");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StandardsError");
  });
});
