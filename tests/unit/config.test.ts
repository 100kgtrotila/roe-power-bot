import { expect, test } from "vitest";
import { parseAllowedIds } from "../../src/config";

test("allowlist fails closed for absent or malformed IDs", () => {
  for (const value of [undefined, "", "42,alice", "0", "-1", "1.5", "42,,43"])
    expect(parseAllowedIds(value).size).toBe(0);
  expect([...parseAllowedIds("42, 43,42")]).toEqual(["42", "43"]);
});
