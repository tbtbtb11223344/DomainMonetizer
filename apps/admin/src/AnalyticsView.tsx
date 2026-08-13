import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { getAnalyticsTimeseries, type AnalyticsComparison, type AnalyticsPoint, type AnalyticsRange, type AnalyticsTimeseries } from "./api";

const WIDTH = 1200;
const HEIGHT = 430;
const LEFT = 64;
const RIGHT = 24;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const VISITOR_TOP = 42;
const VISITOR_BOTTOM = 226;
const CLICK_TOP = 292;
const CLICK_BOTTOM = 380;

function number(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("en-US").format(value);
}

function dateLabel(value: string, full = false): string {
  return new Intl.DateTimeFormat("en-US", full
    ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00.000Z`));
}

function delta(value: number | null, comparison: AnalyticsComparison | null): ReactNode {
  if (!comparison || value === null) return null;
  const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
  return <span className={`analytics-delta ${direction}`}>{value > 0 ? "+" : ""}{Math.round(value)}% <em>vs {comparison.label}</em></span>;
}

function qualityLabel(point: AnalyticsPoint): string {
  if (point.visitorQualityReason === "sampled") return `Sampling-adjusted ×${point.sampleInterval}`;
  if (point.visitorQualityReason === "legacy") return "Legacy estimate";
  if (point.visitorQualityReason === "not_measured") return "Measurement not started";
  if (point.visitorQualityReason === "rollup_unavailable") return "Rollup unavailable";
  return point.telemetryVerified ? "Exact · pipeline verified" : "Exact · pipeline unverified";
}

function Chart({ points }: { points: AnalyticsPoint[] }) {
  const visitorGradient = useId().replaceAll(":", "");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const visitorMax = Math.max(1, ...points.map((point) => point.usQualifiedVisitors ?? 0));
  const callMax = Math.max(1, ...points.map((point) => point.providerRecordedCalls));
  const x = (index: number) => LEFT + (points.length === 1 ? PLOT_WIDTH / 2 : index * PLOT_WIDTH / (points.length - 1));
  const visitorY = (value: number) => VISITOR_BOTTOM - (value / visitorMax) * (VISITOR_BOTTOM - VISITOR_TOP);
  const callY = (value: number) => CLICK_BOTTOM - (value / callMax) * (CLICK_BOTTOM - CLICK_TOP);
  const labelIndexes = useMemo(() => {
    if (!points.length) return [];
    const count = Math.min(6, points.length);
    return [...new Set(Array.from({ length: count }, (_, index) => Math.round(index * (points.length - 1) / Math.max(1, count - 1))))];
  }, [points]);
  const visitorAreaSegments = points.reduce<Array<Array<{ index: number; value: number }>>>((segments, point, index) => {
    if (point.usQualifiedVisitors === null) return segments;
    const previousUnavailable = index === 0 || points[index - 1]?.usQualifiedVisitors === null;
    if (previousUnavailable) segments.push([]);
    segments.at(-1)!.push({ index, value: point.usQualifiedVisitors });
    return segments;
  }, []);
  const active = activeIndex === null ? null : points[activeIndex];

  return <div className="analytics-chart-shell">
    <div className="analytics-legend" aria-hidden="true">
      <span><i className="legend-line visitors" /> U.S. qualified visitors</span>
      <span><i className="legend-line calls" /> Marketcall-recorded calls</span>
      <span><i className="legend-line estimated" /> Estimate</span>
    </div>
    {!points.length ? <div className="analytics-empty">No completed UTC days are available in this range.</div> : <svg className="analytics-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Daily U.S. qualified visitors and Marketcall-recorded calls">
      <defs>
        <linearGradient id={visitorGradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#245cff" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#245cff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((ratio) => <g key={`v-${ratio}`}>
        <line className="chart-grid" x1={LEFT} x2={WIDTH - RIGHT} y1={VISITOR_BOTTOM - ratio * (VISITOR_BOTTOM - VISITOR_TOP)} y2={VISITOR_BOTTOM - ratio * (VISITOR_BOTTOM - VISITOR_TOP)} />
        <text className="chart-axis-value" x={LEFT - 14} y={VISITOR_BOTTOM - ratio * (VISITOR_BOTTOM - VISITOR_TOP) + 4}>{Math.round(visitorMax * ratio)}</text>
      </g>)}
      {[0, 1].map((ratio) => <g key={`c-${ratio}`}>
        <line className="chart-grid" x1={LEFT} x2={WIDTH - RIGHT} y1={CLICK_BOTTOM - ratio * (CLICK_BOTTOM - CLICK_TOP)} y2={CLICK_BOTTOM - ratio * (CLICK_BOTTOM - CLICK_TOP)} />
        <text className="chart-axis-value" x={LEFT - 14} y={CLICK_BOTTOM - ratio * (CLICK_BOTTOM - CLICK_TOP) + 4}>{Math.round(callMax * ratio)}</text>
      </g>)}
      <text className="chart-plot-label" x={LEFT} y={20}>QUALIFIED AUDIENCE</text>
      <text className="chart-plot-label" x={LEFT} y={272}>PROVIDER CALLS</text>
      {visitorAreaSegments.filter((segment) => segment.length > 1).map((segment) => <path key={`area-${segment[0]!.index}`} className="visitor-area" fill={`url(#${visitorGradient})`} d={`M ${segment.map(({ index, value }) => `${x(index)},${visitorY(value)}`).join(" L ")} L ${x(segment.at(-1)!.index)},${VISITOR_BOTTOM} L ${x(segment[0]!.index)},${VISITOR_BOTTOM} Z`} />)}
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1]!;
        if (point.usQualifiedVisitors === null || next.usQualifiedVisitors === null) return null;
        const estimated = point.visitorQuality === "estimated" || next.visitorQuality === "estimated";
        return <line key={`visitor-${point.date}`} className={`visitor-series${estimated ? " is-estimated" : ""}`} x1={x(index)} y1={visitorY(point.usQualifiedVisitors)} x2={x(index + 1)} y2={visitorY(next.usQualifiedVisitors)} />;
      })}
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1]!;
        return <line key={`call-${point.date}`} className="click-series" x1={x(index)} y1={callY(point.providerRecordedCalls)} x2={x(index + 1)} y2={callY(next.providerRecordedCalls)} />;
      })}
      {points.map((point, index) => <g key={point.date}>
        {point.usQualifiedVisitors !== null && <circle className={`visitor-point ${point.visitorQuality}`} cx={x(index)} cy={visitorY(point.usQualifiedVisitors)} r="4.5" />}
        <circle className="click-point" cx={x(index)} cy={callY(point.providerRecordedCalls)} r="4.5" />
        <rect className="chart-hit" x={x(index) - Math.max(1, PLOT_WIDTH / Math.max(points.length, 1) / 2)} y={0} width={Math.max(2, PLOT_WIDTH / Math.max(points.length, 1))} height={HEIGHT - 28} tabIndex={0} role="button" aria-label={`${dateLabel(point.date, true)}: ${point.usQualifiedVisitors === null ? "visitor data unavailable" : `${point.usQualifiedVisitors} U.S. qualified visitors`}, ${point.providerRecordedCalls} Marketcall-recorded calls, ${point.qualifiedCalls} qualified calls`} onMouseEnter={() => setActiveIndex(index)} onMouseLeave={() => setActiveIndex(null)} onFocus={() => setActiveIndex(index)} onBlur={() => setActiveIndex(null)} />
      </g>)}
      {labelIndexes.map((index) => <text key={points[index]!.date} className="chart-axis-date" x={x(index)} y={416}>{dateLabel(points[index]!.date)}</text>)}
      {active && <g className="chart-crosshair" pointerEvents="none">
        <line x1={x(activeIndex!)} x2={x(activeIndex!)} y1={VISITOR_TOP} y2={CLICK_BOTTOM} />
      </g>}
    </svg>}
    {active && <div className="chart-tooltip" style={{ left: `${Math.min(82, Math.max(18, (x(activeIndex!) / WIDTH) * 100))}%` }}>
      <strong>{dateLabel(active.date, true)}</strong>
      <span><i className="tooltip-dot visitors" /> U.S. qualified <b>{active.usQualifiedVisitors === null ? "—" : `${active.visitorQuality === "estimated" ? "≈" : ""}${number(active.usQualifiedVisitors)}`}</b></span>
      <span><i className="tooltip-dot calls" /> Marketcall calls <b>{number(active.providerRecordedCalls)}</b></span>
      <span>Qualified <b>{number(active.qualifiedCalls)}</b></span>
      <span>Pending review <b>{number(active.pendingCalls)}</b></span>
      <span>Unsuccessful <b>{number(active.unsuccessfulCalls)}</b></span>
      {active.unattributedProviderRecordedCalls > 0 && <span>Unattributed <b>{number(active.unattributedProviderRecordedCalls)}</b></span>}
      <em>{qualityLabel(active)}</em>
    </div>}
  </div>;
}

function Metric({ label, value, comparison }: { label: string; value: string; comparison?: ReactNode }) {
  return <div className="analytics-metric"><span>{label}</span><strong>{value}</strong>{comparison}</div>;
}

function summarySentence(data: AnalyticsTimeseries): string {
  const scope = data.scope.hostname ?? "the portfolio";
  const days = data.points.length;
  if (!days) return `No completed UTC days are available for ${scope}.`;
  const visitorPhrase = data.summary.coverageComplete
    ? `${data.summary.approximate ? "approximately " : ""}${number(data.summary.usQualifiedVisitors)} U.S. qualified visitors`
    : `${number(data.summary.usQualifiedVisitors)} visible U.S. qualified visitors across the available days`;
  return `Across ${days} completed UTC day${days === 1 ? "" : "s"}, ${scope} recorded ${visitorPhrase}. Marketcall reported ${number(data.summary.providerRecordedCalls)} call${data.summary.providerRecordedCalls === 1 ? "" : "s"}, including ${number(data.summary.qualifiedCalls)} qualified.`;
}

export function AnalyticsView() {
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [domainId, setDomainId] = useState("");
  const [data, setData] = useState<AnalyticsTimeseries | null>(null);
  const [availableDomains, setAvailableDomains] = useState<Array<{ id: string; hostname: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAnalyticsTimeseries(range, domainId);
      setData(result);
      setAvailableDomains(result.availableDomains);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analytics could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [range, domainId]);

  useEffect(() => { void load(); }, [load]);

  if (!data && loading) return <section className="analytics-view analytics-loading" aria-busy="true"><div className="analytics-loading-bar" /><div className="analytics-loading-chart" /></section>;
  if (!data) return <section className="analytics-view"><div className="analytics-error" role="alert"><strong>Analytics unavailable</strong><p>{error}</p><button onClick={() => void load()}>Try again</button></div></section>;

  const { summary, comparison } = data;
  return <section className={`analytics-view${loading ? " is-refreshing" : ""}`} aria-busy={loading}>
    <div className="analytics-controls">
      <label><span>Domain</span><select value={domainId} onChange={(event) => setDomainId(event.target.value)}><option value="">All measured domains</option>{availableDomains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}</select></label>
      <fieldset><legend>Period</legend>{(["7d", "30d", "all"] as const).map((value) => <button key={value} type="button" className={range === value ? "active" : ""} aria-pressed={range === value} onClick={() => setRange(value)}>{value === "all" ? "All time" : value}</button>)}</fieldset>
      <p>{dateLabel(data.from, true)} — {dateLabel(data.through, true)} <span>UTC</span></p>
    </div>

    {error && <div className="analytics-stale" role="status">Refresh failed: {error}. Showing the last loaded result. <button onClick={() => void load()}>Retry</button></div>}
    <Chart points={data.points} />

    <div className="analytics-readout">
      <p>{summarySentence(data)} Phone-button clicks and `tel:` handoffs are excluded from every call total.</p>
      <div className="analytics-metrics">
        <Metric label="U.S. qualified" value={`${summary.approximate ? "≈" : ""}${number(summary.usQualifiedVisitors)}`} comparison={delta(comparison?.usQualifiedVisitorsChange ?? null, comparison)} />
        <Metric label="Marketcall calls" value={number(summary.providerRecordedCalls)} comparison={delta(comparison?.providerRecordedCallsChange ?? null, comparison)} />
        <Metric label="Qualified calls" value={number(summary.qualifiedCalls)} comparison={delta(comparison?.qualifiedCallsChange ?? null, comparison)} />
        <Metric label="Pending review" value={number(summary.pendingCalls)} />
        <Metric label="Unsuccessful" value={number(summary.unsuccessfulCalls)} />
      </div>
      <div className="analytics-footnote"><span className={summary.coverageComplete ? "verified" : "warning"}>{summary.coverageComplete ? `Coverage complete through ${dateLabel(data.through, true)}` : data.points.length ? `${summary.unavailableDays} day${summary.unavailableDays === 1 ? "" : "s"} unavailable` : "Coverage not available"}</span><p>{summary.estimatedDays > 0 ? `${summary.estimatedDays} legacy or sampled day${summary.estimatedDays === 1 ? " is" : "s are"} shown as estimates. ` : ""}Exact daily sessions begin {dateLabel(data.exactSessionStartDate, true)}. Gaps are never counted as zero.</p></div>
    </div>

    <div className="analytics-detail">
      <div className="analytics-detail-head"><div><p className="kicker">{data.scope.hostname ? "Daily detail" : "Domain performance"}</p><h2>{data.scope.hostname ? data.scope.hostname : "Marketcall outcomes"}</h2></div><span>{data.scope.hostname ? "Newest first" : `${data.rankings.length} measured domains`}</span></div>
      {data.scope.hostname ? <div className="analytics-table"><table><thead><tr><th>Date</th><th>U.S. qualified</th><th>Marketcall calls</th><th>Qualified</th><th>Pending</th><th>Unsuccessful</th></tr></thead><tbody>{[...data.points].reverse().map((point) => <tr key={point.date}><td><strong>{dateLabel(point.date, true)}</strong><small>{qualityLabel(point)}</small></td><td>{point.usQualifiedVisitors === null ? "—" : `${point.visitorQuality === "estimated" ? "≈" : ""}${number(point.usQualifiedVisitors)}`}</td><td>{number(point.providerRecordedCalls)}</td><td>{number(point.qualifiedCalls)}</td><td>{number(point.pendingCalls)}</td><td>{number(point.unsuccessfulCalls)}</td></tr>)}</tbody></table>{!data.points.length && <div className="analytics-empty compact">No completed UTC days are available for this domain.</div>}</div>
      : <div className="analytics-table"><table><thead><tr><th>Domain</th><th>U.S. qualified</th><th>Marketcall calls</th><th>Qualified</th><th>Pending</th><th>Unsuccessful</th></tr></thead><tbody>{data.rankings.map((row) => <tr key={row.domainId}><td><button className="analytics-domain-button" onClick={() => setDomainId(row.domainId)}><strong>{row.hostname}</strong><small>{row.coverageComplete ? row.approximate ? "Includes estimates" : "Complete" : "Partial coverage"}</small></button></td><td>{row.coverageComplete ? `${row.approximate ? "≈" : ""}${number(row.usQualifiedVisitors)}` : number(row.usQualifiedVisitors)}</td><td>{number(row.providerRecordedCalls)}</td><td>{number(row.qualifiedCalls)}</td><td>{number(row.pendingCalls)}</td><td>{number(row.unsuccessfulCalls)}</td></tr>)}</tbody></table>{!data.rankings.length && <div className="analytics-empty compact">No measured domains are available.</div>}</div>}
      {summary.unattributedProviderRecordedCalls > 0 && <p className="unattributed-note"><strong>{number(summary.unattributedProviderRecordedCalls)} Marketcall-recorded call{summary.unattributedProviderRecordedCalls === 1 ? " is" : "s are"} unattributed.</strong> Shared-number provider events without an exact click ID remain in the portfolio total but outside domain rows.{summary.unattributedQualifiedCalls > 0 ? ` ${number(summary.unattributedQualifiedCalls)} of those calls qualified.` : ""}</p>}
    </div>
  </section>;
}
