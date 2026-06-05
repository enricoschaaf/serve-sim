import { describe, expect, test } from "bun:test";
import {
  buildAppCommand,
  buildDiskCommand,
  buildMetricsCommand,
  formatCpu,
  formatKb,
  METRICS_HISTORY,
  parseAppStats,
  parseDisk,
  parseFootprintSize,
  parseMetrics,
  pushHistory,
  sparklinePoints,
} from "../client/components/metrics-tool";

describe("buildMetricsCommand", () => {
  const udid = "E8ABF259-AF25-47A8-B68B-AF56104527B5";
  test("keys the rollup on the device data dir", () => {
    expect(buildMetricsCommand(udid)).toContain(`Devices/${udid}/data`);
  });
  test("reads env via ps -E and excludes the probe pipeline", () => {
    const cmd = buildMetricsCommand(udid);
    expect(cmd).toContain("ps -axE");
    expect(cmd).toContain("/-o pid=|awk -v/");
  });
});

describe("buildDiskCommand", () => {
  test("measures the device data dir and its volume", () => {
    const cmd = buildDiskCommand("UDID-1");
    expect(cmd).toContain("Devices/UDID-1/data");
    expect(cmd).toContain("du -sk");
    expect(cmd).toContain("df -k");
  });
  test("double-quotes the dir so $HOME expands", () => {
    expect(buildDiskCommand("UDID-1")).toContain('DIR="$HOME/');
  });
});

describe("parseMetrics", () => {
  test("parses a well-formed rollup", () => {
    expect(parseMetrics('{"cpu":12.3,"memKb":24307840,"procs":259}')).toEqual({
      cpu: 12.3,
      memKb: 24307840,
      procs: 259,
    });
  });
  test("tolerates trailing whitespace", () => {
    expect(parseMetrics('{"cpu":0,"memKb":0,"procs":0}\n')).toEqual({
      cpu: 0,
      memKb: 0,
      procs: 0,
    });
  });
  test("returns null for garbage", () => {
    expect(parseMetrics("not json")).toBeNull();
    expect(parseMetrics("")).toBeNull();
  });
  test("returns null when a field is missing or non-numeric", () => {
    expect(parseMetrics('{"cpu":1,"memKb":2}')).toBeNull();
    expect(parseMetrics('{"cpu":"x","memKb":2,"procs":3}')).toBeNull();
  });
});

describe("parseDisk", () => {
  test("parses used + free", () => {
    expect(parseDisk('{"usedKb":6672556,"freeKb":1208409156}')).toEqual({
      usedKb: 6672556,
      freeKb: 1208409156,
    });
  });
  test("returns null when du produced nothing", () => {
    // `du` failure leaves an empty substitution → invalid JSON.
    expect(parseDisk('{"usedKb":,"freeKb":123}')).toBeNull();
  });
});

describe("buildAppCommand", () => {
  test("reads %cpu and phys_footprint for the pid, truncated to an int", () => {
    const cmd = buildAppCommand(5895.9);
    expect(cmd).toContain("ps -o %cpu= -p 5895 ");
    expect(cmd).toContain("footprint 5895 ");
    expect(cmd).toContain('$1=="phys_footprint:"');
    expect(cmd).toContain('$1=="phys_footprint_peak:"');
  });
});

describe("parseFootprintSize", () => {
  test("scales by unit to KiB", () => {
    expect(parseFootprintSize("191 MB")).toBe(195584);
    expect(parseFootprintSize("768 KB")).toBe(768);
    expect(parseFootprintSize("1.86 GB")).toBe(1950351);
    expect(parseFootprintSize("512 bytes")).toBe(1); // rounds 0.5
  });
  test("is case-insensitive and tolerates spacing", () => {
    expect(parseFootprintSize("191mb")).toBe(195584);
  });
  test("returns null for junk", () => {
    expect(parseFootprintSize("")).toBeNull();
    expect(parseFootprintSize("MB")).toBeNull();
    expect(parseFootprintSize("191 PB")).toBeNull();
  });
});

describe("parseAppStats", () => {
  test("parses cpu + footprint + peak", () => {
    expect(parseAppStats('{"cpu":"2.4","foot":"191 MB","peak":"222 MB"}')).toEqual({
      cpu: 2.4,
      footKb: 195584,
      peakKb: 227328,
    });
  });
  test("falls back peak to current when peak is missing", () => {
    expect(parseAppStats('{"cpu":"0","foot":"191 MB","peak":""}')).toEqual({
      cpu: 0,
      footKb: 195584,
      peakKb: 195584,
    });
  });
  test("cpu is null when ps produced nothing", () => {
    expect(parseAppStats('{"cpu":"","foot":"191 MB","peak":"191 MB"}')).toEqual({
      cpu: null,
      footKb: 195584,
      peakKb: 195584,
    });
  });
  test("returns null when footprint is absent (dead/invalid pid)", () => {
    expect(parseAppStats('{"cpu":"1.0","foot":"","peak":""}')).toBeNull();
    expect(parseAppStats("not json")).toBeNull();
  });
});

describe("formatKb", () => {
  test("scales to a sensible unit", () => {
    expect(formatKb(512)).toBe("512 KB");
    expect(formatKb(2048)).toBe("2.0 MB");
    expect(formatKb(24307840)).toBe("23.2 GB");
  });
  test("drops decimals at/above 100 of a unit", () => {
    expect(formatKb(150 * 1024)).toBe("150 MB");
  });
  test("clamps negatives to zero", () => {
    expect(formatKb(-5)).toBe("0 KB");
  });
});

describe("formatCpu", () => {
  test("one decimal under 100", () => {
    expect(formatCpu(12.34)).toBe("12.3%");
  });
  test("no decimal at/above 100", () => {
    expect(formatCpu(245.6)).toBe("246%");
  });
});

describe("pushHistory", () => {
  test("appends within the cap", () => {
    expect(pushHistory([1, 2], 3)).toEqual([1, 2, 3]);
  });
  test("drops the oldest at the cap", () => {
    const full = Array.from({ length: METRICS_HISTORY }, (_, i) => i);
    const next = pushHistory(full, 999);
    expect(next).toHaveLength(METRICS_HISTORY);
    expect(next[0]).toBe(1);
    expect(next[next.length - 1]).toBe(999);
  });
  test("does not mutate the input", () => {
    const input = [1, 2];
    pushHistory(input, 3);
    expect(input).toEqual([1, 2]);
  });
});

describe("sparklinePoints", () => {
  test("empty series yields no points", () => {
    expect(sparklinePoints([], 64, 18)).toBe("");
  });
  test("maps a flat-zero series to the baseline", () => {
    const pts = sparklinePoints([0, 0, 0], 64, 18);
    expect(pts).toBe("0.0,18.0 32.0,18.0 64.0,18.0");
  });
  test("peak value sits at the top of the box", () => {
    const pts = sparklinePoints([0, 10], 64, 18, 10);
    expect(pts).toBe("0.0,18.0 64.0,0.0");
  });
});
