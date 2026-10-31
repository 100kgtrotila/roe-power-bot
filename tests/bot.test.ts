import { expect, test } from "vitest";
import { parseCallback } from "../src/bot/callbacks";

test("callback grammar rejects malformed state and unsupported actions", () => {
  for (const input of [
    "42:select:7.1",
    "42:interval:45",
    "42:updates:toggle",
    "42:stop:all:extra",
    "abc:view:all",
    "",
  ])
    expect(parseCallback(input)).toBeNull();
  expect(parseCallback("42:view:all")).toEqual({
    owner: "42",
    kind: "view",
    view: "all",
  });
});
