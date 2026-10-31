import { describe, expect, it } from "vitest";
import { retryAfterDelay } from "../../src/schedule/source";

describe("Retry-After", () => {
  it("accepts seconds and HTTP dates without accepting invalid numbers", () => {
    expect(retryAfterDelay("600", 0)).toBe(600000);
    expect(retryAfterDelay("Thu, 01 Jan 1970 00:10:00 GMT", 0)).toBe(600000);
    for (const value of ["-1", "1.5", "Infinity", "garbage", null])
      expect(retryAfterDelay(value, 0)).toBe(0);
  });
});
