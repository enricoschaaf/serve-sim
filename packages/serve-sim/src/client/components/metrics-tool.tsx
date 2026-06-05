// Live device metrics panel — CPU, Memory, Disk, process count.
//
// Everything runs through the existing `/exec` host-shell route (the same path
// the location/camera tools use) so it works for UI-started helpers too, which
// run the npm-published binary and never see local middleware routes.
//
// A booted simulator's whole process tree shares the device data dir in each
// child's environment (CFFIXED_USER_HOME=.../Devices/<udid>/data). We sum the
// `ps` %cpu/rss across every process whose env or argv references that path,
// which gives a device-level CPU + memory rollup without walking the pid tree.

import { useEffect, useRef, useState } from "react";
import { Chevron } from "../icons";

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
type ExecFn = (cmd: string) => Promise<ExecResult>;

/** Cheap rollup (CPU/RSS/proc count) — safe to poll on a short cadence. */
export const METRICS_POLL_INTERVAL_MS = 2000;
/** `du` over the data dir is ~1s, so disk refreshes on a slower cadence. */
export const DISK_POLL_INTERVAL_MS = 20_000;
/** Samples retained for the sparklines. */
export const METRICS_HISTORY = 40;

export interface DeviceMetrics {
  /** Summed %cpu across the device's processes (100 == one full core). */
  cpu: number;
  /** Summed resident memory, KiB. */
  memKb: number;
  /** Number of processes attributed to the device. */
  procs: number;
}

export interface DiskMetrics {
  /** Size of the device data dir, KiB. */
  usedKb: number;
  /** Free space on the volume backing the data dir, KiB. */
  freeKb: number;
}

// ─── Commands ──────────────────────────────────────────────────────────────

/**
 * Build the rollup command for `udid`. Sums %cpu + rss over every process whose
 * `ps -E` line (argv + environment) references the device data dir. The awk
 * guard drops the measurement pipeline itself (the `ps`/`awk`/`sh -c` lines all
 * carry the key string) so we don't count our own probe.
 */
export function buildMetricsCommand(udid: string): string {
  const key = `Devices/${udid}/data`;
  return (
    `ps -axE -o pid=,%cpu=,rss=,command= 2>/dev/null | ` +
    `awk -v k='${key}' 'index($0,k)>0 && $0 !~ /-o pid=|awk -v/ {c+=$2;r+=$3;n++} ` +
    `END{printf "{\\"cpu\\":%.1f,\\"memKb\\":%d,\\"procs\\":%d}",c,r,n}'`
  );
}

/** Build the disk command: data-dir size (`du`) + volume free space (`df`). */
export function buildDiskCommand(udid: string): string {
  // Double-quote so $HOME expands; the udid is validated hex so it's shell-safe.
  const dir = `$HOME/Library/Developer/CoreSimulator/Devices/${udid}/data`;
  return (
    `DIR="${dir}"; ` +
    `printf '{"usedKb":%s,"freeKb":%s}' ` +
    `"$(du -sk \"$DIR\" 2>/dev/null | cut -f1)" ` +
    `"$(df -k \"$DIR\" 2>/dev/null | awk 'NR==2{print $4}')"`
  );
}

export interface AppStats {
  /** Process %cpu (can exceed 100 across cores); null when unavailable. */
  cpu: number | null;
  /** Current phys_footprint, KiB. */
  footKb: number;
  /** Peak phys_footprint, KiB. */
  peakKb: number;
}

/**
 * Per-app CPU + memory for `pid`. `ps -o %cpu` gives the process's CPU share,
 * and `footprint` gives `phys_footprint` — the same counter Instruments/Xcode
 * show (shared + compressed pages), unlike the device-wide RSS sum. `footprint`
 * rounds to whole MB and the pair runs in ~0.2s.
 */
export function buildAppCommand(pid: number): string {
  const safe = Math.trunc(pid);
  return (
    `C=$(ps -o %cpu= -p ${safe} 2>/dev/null | tr -d '[:space:]'); ` +
    `footprint ${safe} 2>/dev/null | awk -v cpu="$C" '` +
    `$1=="phys_footprint:"{foot=$2" "$3} ` +
    `$1=="phys_footprint_peak:"{peak=$2" "$3} ` +
    `END{printf "{\\"cpu\\":\\"%s\\",\\"foot\\":\\"%s\\",\\"peak\\":\\"%s\\"}",cpu,foot,peak}'`
  );
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseMetrics(stdout: string): DeviceMetrics | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const cpu = finiteNumber(obj.cpu);
  const memKb = finiteNumber(obj.memKb);
  const procs = finiteNumber(obj.procs);
  if (cpu === null || memKb === null || procs === null) return null;
  return { cpu, memKb, procs };
}

export function parseDisk(stdout: string): DiskMetrics | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const usedKb = finiteNumber(obj.usedKb);
  const freeKb = finiteNumber(obj.freeKb);
  if (usedKb === null || freeKb === null) return null;
  return { usedKb, freeKb };
}

const SIZE_UNIT_KB: Record<string, number> = {
  B: 1 / 1024,
  BYTES: 1 / 1024,
  KB: 1,
  MB: 1024,
  GB: 1024 * 1024,
  TB: 1024 * 1024 * 1024,
};

/** Parse a `footprint`-style "191 MB" / "1.86 GB" size into KiB; null if bad. */
export function parseFootprintSize(text: string): number | null {
  const match = text.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  const factor = SIZE_UNIT_KB[match[2]!.toUpperCase()];
  if (!Number.isFinite(value) || factor === undefined) return null;
  return Math.round(value * factor);
}

export function parseAppStats(stdout: string): AppStats | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const footKb = typeof obj.foot === "string" ? parseFootprintSize(obj.foot) : null;
  if (footKb === null) return null;
  const peakKb = typeof obj.peak === "string" ? parseFootprintSize(obj.peak) : null;
  const cpuRaw = typeof obj.cpu === "string" ? Number.parseFloat(obj.cpu) : NaN;
  const cpu = Number.isFinite(cpuRaw) ? cpuRaw : null;
  return { cpu, footKb, peakKb: peakKb ?? footKb };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Human-readable size from a KiB count (e.g. 24307840 → "23.2 GB"). */
export function formatKb(kb: number): string {
  let value = Math.max(0, kb);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** CPU percent — single decimal, can exceed 100 across multiple cores. */
export function formatCpu(pct: number): string {
  return `${pct.toFixed(pct >= 100 ? 0 : 1)}%`;
}

/** Append `next` to `history`, capped at METRICS_HISTORY samples. */
export function pushHistory(history: number[], next: number): number[] {
  const out = history.length >= METRICS_HISTORY ? history.slice(1) : history.slice();
  out.push(next);
  return out;
}

/**
 * SVG polyline points for a sparkline scaled to `width`×`height`. The series is
 * normalised against `max` (or its own peak) so idle traces still read as flat.
 */
export function sparklinePoints(
  values: number[],
  width: number,
  height: number,
  max?: number,
): string {
  if (values.length === 0) return "";
  const peak = Math.max(max ?? 0, ...values, 1e-6);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - (Math.max(0, v) / peak) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// ─── Presentational pieces ───────────────────────────────────────────────────

export function Sparkline({
  values,
  color,
  max,
}: {
  values: number[];
  color: string;
  max?: number;
}) {
  const width = 44;
  const height = 18;
  const points = sparklinePoints(values, width, height, max);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden="true"
    >
      {points && (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function MetricRow({
  label,
  value,
  sub,
  spark,
}: {
  label: string;
  value: string;
  sub?: string;
  spark?: ReactSpark;
}) {
  return (
    <div className="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 min-h-[26px]">
      <span className="text-[11px] text-white/55">{label}</span>
      <span className="justify-self-end text-[12px] font-mono text-white/90 tabular-nums whitespace-nowrap">
        {value}
        {sub && <span className="text-white/40"> {sub}</span>}
      </span>
      <span className="justify-self-end flex items-center w-12 shrink-0">
        {spark ? <Sparkline values={spark.values} color={spark.color} max={spark.max} /> : null}
      </span>
    </div>
  );
}

interface ReactSpark {
  values: number[];
  color: string;
  max?: number;
}

// ─── Tool component ──────────────────────────────────────────────────────────

export function MetricsTool({
  udid,
  exec,
  app,
}: {
  udid: string;
  exec: ExecFn;
  app: { pid?: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [metrics, setMetrics] = useState<DeviceMetrics | null>(null);
  const [appStats, setAppStats] = useState<AppStats | null>(null);
  const [disk, setDisk] = useState<DiskMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);

  const appPid = app?.pid ?? null;

  // Reset the per-app traces when the foreground app changes so the sparklines
  // don't splice two unrelated processes together.
  useEffect(() => {
    setAppStats(null);
    setCpuHistory([]);
    setMemHistory([]);
  }, [appPid]);

  // Poll the foreground app's CPU + phys_footprint, plus the device rollup for
  // the process count, while the tool is expanded. Skips overlapping requests
  // so a slow host can't queue up probes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let inflight = false;

    const sample = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const [deviceRes, appRes] = await Promise.all([
          exec(buildMetricsCommand(udid)),
          appPid !== null ? exec(buildAppCommand(appPid)) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const next = parseMetrics(deviceRes.stdout);
        if (next) {
          setMetrics(next);
          setError(null);
        } else if (deviceRes.exitCode !== 0) {
          setError(deviceRes.stderr.trim() || "metrics probe failed");
        }
        const stats = appRes ? parseAppStats(appRes.stdout) : null;
        if (stats) {
          setAppStats(stats);
          if (stats.cpu !== null) setCpuHistory((h) => pushHistory(h, stats.cpu!));
          setMemHistory((h) => pushHistory(h, stats.footKb));
        } else if (appPid === null) {
          setAppStats(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        inflight = false;
      }
    };

    void sample();
    const id = setInterval(sample, METRICS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, udid, exec, appPid]);

  // Disk usage on a slower cadence — `du` over the data dir is expensive.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const sample = () => {
      void exec(buildDiskCommand(udid)).then((res) => {
        if (cancelled) return;
        const next = parseDisk(res.stdout);
        if (next) setDisk(next);
      });
    };
    sample();
    const id = setInterval(sample, DISK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, udid, exec]);

  const diskTotalKb = disk ? disk.usedKb + disk.freeKb : null;

  const headerStatus = appStats
    ? `${appStats.cpu !== null ? `${formatCpu(appStats.cpu)} CPU · ` : ""}${formatKb(appStats.footKb)}`
    : open
      ? appPid === null
        ? "no app"
        : "sampling…"
      : "—";

  return (
    <div className="bg-panel border border-white/8 rounded-[10px] flex flex-col gap-2.5 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 bg-transparent border-none text-white/90 py-2.5 px-1 -my-2 -mx-1 cursor-pointer w-[calc(100%+8px)] text-left min-h-[36px] leading-none hover:text-white"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
          Metrics
        </span>
        <span className="text-[11px] text-white/55 font-mono inline-flex items-center gap-1.5 justify-self-end leading-none">
          <span
            className="size-1.5 rounded-full [transition:background_0.2s,box-shadow_0.2s]"
            style={{
              background: open && appStats ? "#4ade80" : "rgba(255,255,255,0.3)",
              boxShadow: open && appStats ? "0 0 6px rgba(74,222,128,0.7)" : "none",
            }}
          />
          {headerStatus}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="flex flex-col gap-1.5 pb-1">
          <MetricRow
            label="CPU"
            value={
              appStats?.cpu != null
                ? formatCpu(appStats.cpu)
                : appPid === null
                  ? "—"
                  : "…"
            }
            sub={appPid === null ? "no app" : undefined}
            spark={{ values: cpuHistory, color: "#a5b4fc" }}
          />
          <MetricRow
            label="Memory"
            value={
              appStats
                ? formatKb(appStats.footKb)
                : appPid === null
                  ? "—"
                  : "…"
            }
            sub={
              appStats
                ? `· ${formatKb(appStats.peakKb)} pk`
                : appPid === null
                  ? "no app"
                  : undefined
            }
            spark={{ values: memHistory, color: "#4ade80" }}
          />
          <MetricRow
            label="Disk"
            value={disk ? formatKb(disk.usedKb) : "—"}
            sub={
              diskTotalKb
                ? `· ${formatKb(disk!.freeKb)} free`
                : undefined
            }
          />
          <MetricRow
            label="Processes"
            value={metrics ? String(metrics.procs) : "—"}
          />
          {error && (
            <div className="text-[10px] text-danger/90 font-mono break-words pt-0.5">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
