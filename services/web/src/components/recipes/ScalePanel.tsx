import { Select } from "#/components/ui/select";

/**
 * Scale & convert disclosure panel (design handoff). `factor`/`metric` come from
 * the shell (shared across recipes for the session, plan §5.3). Reset returns to
 * 1× / US.
 */
export function ScalePanel({
  factor,
  metric,
  onFactor,
  onMetric,
  onReset,
}: {
  factor: number;
  metric: boolean;
  onFactor: (n: number) => void;
  onMetric: (b: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-border bg-card p-2">
      <label className="flex items-center gap-1.5 text-[0.6875rem] font-semibold text-muted-foreground">
        Scale
        <Select size="xs" value={String(factor)} onChange={(e) => onFactor(Number(e.target.value))} aria-label="Scale factor" className="w-auto">
          <option value="0.5">0.5×</option>
          <option value="1">1×</option>
          <option value="1.5">1.5×</option>
          <option value="2">2×</option>
          <option value="3">3×</option>
        </Select>
      </label>
      <label className="flex items-center gap-1.5 text-[0.6875rem] font-semibold text-muted-foreground">
        Units
        <Select size="xs" value={metric ? "metric" : "us"} onChange={(e) => onMetric(e.target.value === "metric")} aria-label="Unit system" className="w-auto">
          <option value="us">Imperial (US)</option>
          <option value="metric">Metric</option>
        </Select>
      </label>
      <button
        type="button"
        onClick={onReset}
        className="ml-auto cursor-(--cursor-interactive) text-[0.6875rem] font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Reset
      </button>
    </div>
  );
}
