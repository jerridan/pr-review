import { describe, expect, it } from "vitest";
import {
  formatFingerprintMarker,
  formatRunMarker,
  parseFingerprintMarkers,
  parseRunMarker,
  parseSeverity,
  type RunMarker,
} from "../src/github/markers.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RUN = "2026-10-13T123456.789Z-aaaaaaa";

describe("run marker (R5)", () => {
  it("has the form of R5, with the tier after the base", () => {
    expect(formatRunMarker({ run: RUN, head: HEAD, base: BASE, tier: "full" })).toBe(
      `<!-- pr-review run=${RUN} head=${HEAD} base=${BASE} tier=full -->`,
    );
  });

  it("adds status=failed after the tier", () => {
    expect(
      formatRunMarker({ run: RUN, head: HEAD, base: BASE, tier: "unknown", status: "failed" }),
    ).toBe(`<!-- pr-review run=${RUN} head=${HEAD} base=${BASE} tier=unknown status=failed -->`);
  });

  it("parses what it formats", () => {
    const markers: RunMarker[] = [
      { run: RUN, head: HEAD, base: BASE, tier: "skip" },
      { run: RUN, head: HEAD, base: BASE, tier: "fast" },
      { run: RUN, head: HEAD, base: BASE, tier: "unknown", status: "failed" },
    ];
    for (const m of markers) {
      expect(parseRunMarker(`${formatRunMarker(m)} **Would approve** at tier x\nmore`)).toEqual(m);
    }
  });

  it("gives null for a body with no marker, a bad tier or no tier", () => {
    expect(parseRunMarker("Just a review.")).toBeNull();
    expect(
      parseRunMarker(`<!-- pr-review run=${RUN} head=${HEAD} base=${BASE} tier=huge -->`),
    ).toBeNull();
    expect(parseRunMarker(`<!-- pr-review run=${RUN} head=${HEAD} base=${BASE} -->`)).toBeNull();
  });

  it("ignores an unknown extra key, and keeps only status=failed", () => {
    expect(
      parseRunMarker(
        `<!-- pr-review run=${RUN} head=${HEAD} base=${BASE} tier=full extra=1 status=odd -->`,
      ),
    ).toEqual({ run: RUN, head: HEAD, base: BASE, tier: "full" });
  });
});

describe("fingerprint markers (R5)", () => {
  it("formats and parses every marker in a body, in order", () => {
    expect(formatFingerprintMarker("0123456789abcdef")).toBe(
      "<!-- pr-review fp=0123456789abcdef -->",
    );
    const body = [
      "intro",
      `- one ${formatFingerprintMarker("aaaaaaaaaaaaaaaa")}`,
      `- two ${formatFingerprintMarker("bbbbbbbbbbbbbbbb")}`,
      "<!-- pr-review fp=not-hex -->",
    ].join("\n");
    expect(parseFingerprintMarkers(body)).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(parseFingerprintMarkers("none")).toEqual([]);
  });
});

describe("severity (R5)", () => {
  it("reads the bold severity word", () => {
    expect(parseSeverity("**blocking** Bug at a.ts:1: x")).toBe("blocking");
    expect(parseSeverity("text **Suggestion** more")).toBe("suggestion");
    expect(parseSeverity("**nit**")).toBe("nit");
    expect(parseSeverity("blocking, but not bold")).toBeNull();
    expect(parseSeverity("**major** x")).toBeNull();
  });
});
