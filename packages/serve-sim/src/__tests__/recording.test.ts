import { describe, expect, test } from "bun:test";
import { keptRecordingRanges, parseFreezeRanges } from "../recording";

describe("recording compaction", () => {
  test("parses completed and trailing freeze ranges", () => {
    const stderr = [
      "lavfi.freezedetect.freeze_start: 2",
      "lavfi.freezedetect.freeze_duration: 8",
      "lavfi.freezedetect.freeze_end: 10",
      "lavfi.freezedetect.freeze_start: 12.5",
    ].join("\n");
    expect(parseFreezeRanges(stderr, 20)).toEqual([
      { start: 2, end: 10 },
      { start: 12.5, end: 20 },
    ]);
  });

  test("keeps a readable hold instead of proportional stale time", () => {
    expect(keptRecordingRanges(20, [
      { start: 2, end: 10 },
      { start: 12, end: 19 },
    ])).toEqual([
      { start: 0, end: 3.5 },
      { start: 10, end: 13.5 },
      { start: 19, end: 20 },
    ]);
  });
});
