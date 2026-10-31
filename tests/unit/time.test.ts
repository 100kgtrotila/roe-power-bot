import { describe, expect, it } from "vitest";
import { getKyivDates, getOutageStart } from "../../src/schedule/time";

describe("Kyiv time", () => {
  it("uses Kyiv midnight and calendar tomorrow", () => {
    expect(getKyivDates(Date.parse("2026-10-31T21:59:00Z"))).toEqual({
      today: "2026-10-31",
      tomorrow: "2026-11-01",
    });
    expect(getKyivDates(Date.parse("2026-10-31T22:00:00Z"))).toEqual({
      today: "2026-11-01",
      tomorrow: "2026-11-02",
    });
    expect(getKyivDates(Date.parse("2026-12-31T22:00:00Z"))).toEqual({
      today: "2027-01-01",
      tomorrow: "2027-01-02",
    });
  });
  it("converts winter and summer starts", () => {
    expect(getOutageStart("2026-01-01", 480)).toBe(
      Date.parse("2026-01-01T06:00:00Z"),
    );
    expect(getOutageStart("2026-07-01", 480)).toBe(
      Date.parse("2026-07-01T05:00:00Z"),
    );
  });
  it.each([
    ["2026-03-29", 210],
    ["2026-10-25", 210],
    ["2026-01-01", 1440],
    ["2026-02-30", 0],
    ["2026-01-01", -1],
    ["2026-01-01", 0.5],
  ])("rejects invalid, missing or ambiguous local starts", (date, minute) => {
    expect(getOutageStart(date, minute)).toBeNull();
  });
});
