import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getDomain, getMetricsOverview, listAuditEvents, listCohorts, listDomains, listJobs, mutate, type AuditEvent, type CohortSummary, type DomainDetail, type DomainSummary, type JobSummary, type MetricsOverview } from "./api";
import "./styles.css";

type View = "portfolio" | "jobs" | "audit";

function initialView(): View {
  const hash = window.location.hash.slice(1);
  return hash === "jobs" || hash === "audit" ? hash : "portfolio";
}

const statusLabels: Record<DomainSummary["lifecycleStatus"], string> = {
  draft: "Draft",
  ready: "Ready",
  published: "Live",
  paused: "Paused",
  retired: "Retired",
};

function formatNumber(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("en-US").format(value);
}

function formatMoney(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatPercent(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}

function formatReason(value: string): string {
  return value.replaceAll("_", " ");
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not checked";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}

function formatTimeBucket(value: string): string {
  if (!/^\d{2}-\d{2}$/.test(value)) return "Local time unavailable";
  const [start, end] = value.split("-");
  return `${start}:00-${end}:59 local`;
}

function App() {
  const [view, setView] = useState<View>(initialView);
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DomainDetail | null>(null);
  const [overview, setOverview] = useState<MetricsOverview | null>(null);
  const [cohorts, setCohorts] = useState<CohortSummary[]>([]);
  const [cohort, setCohort] = useState("pilot-2026-08-05");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [auxiliaryLoading, setAuxiliaryLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [domainResult, metricsResult] = await Promise.allSettled([listDomains(search, cohort), getMetricsOverview(cohort)]);
      if (domainResult.status === "rejected") throw domainResult.reason;
      const result = domainResult.value;
      setDomains(result);
      if (metricsResult.status === "fulfilled") {
        setOverview(metricsResult.value);
        setError(null);
      } else {
        setOverview(null);
        const message = metricsResult.reason instanceof Error ? metricsResult.reason.message : "Cohort metrics are unavailable";
        setError(`Portfolio loaded, but cohort metrics could not be loaded: ${message}`);
      }
      const firstDomain = result.at(0);
      if (firstDomain) setSelected((currentSelection) => currentSelection ?? firstDomain.hostname);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load domains");
    } finally {
      setLoading(false);
    }
  }, [search, cohort]);

  const refreshDetail = useCallback(async () => {
    if (!selected) return setDetail(null);
    try {
      setDetail(await getDomain(selected));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load domain");
    }
  }, [selected]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void listCohorts().then(setCohorts).catch(() => undefined); }, []);
  useEffect(() => { void refreshDetail(); }, [refreshDetail]);
  useEffect(() => {
    const syncViewFromHash = () => setView(initialView());
    window.addEventListener("hashchange", syncViewFromHash);
    return () => window.removeEventListener("hashchange", syncViewFromHash);
  }, []);
  useEffect(() => {
    if (view === "portfolio") return;
    setAuxiliaryLoading(true);
    const pending = view === "jobs" ? listJobs() : listAuditEvents();
    void pending.then((result) => {
      if (view === "jobs") setJobs(result as JobSummary[]);
      else setAuditEvents(result as AuditEvent[]);
      setError(null);
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : `Could not load ${view}`);
    }).finally(() => setAuxiliaryLoading(false));
  }, [view]);

  const totals = useMemo(() => ({
    live: domains.filter((domain) => domain.lifecycleStatus === "published").length,
  }), [domains]);

  const metricByDomain = useMemo(() => new Map(overview?.domains.map((metric) => [metric.domain_id, metric]) ?? []), [overview]);
  const healthByDomain = useMemo(() => new Map(overview?.healthChecks.map((check) => [check.domainId, check]) ?? []), [overview]);
  const jobTotals = useMemo(() => ({
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
    failed: jobs.filter((job) => job.status === "failed").length,
  }), [jobs]);
  const pageTitle = view === "portfolio" ? "Portfolio control" : view === "jobs" ? "Generation jobs" : "Audit trail";

  const reloadAuxiliary = async () => {
    setAuxiliaryLoading(true);
    try {
      if (view === "jobs") setJobs(await listJobs());
      if (view === "audit") setAuditEvents(await listAuditEvents());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not load ${view}`);
    } finally {
      setAuxiliaryLoading(false);
    }
  };

  const action = async (path: string, confirmation?: string) => {
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(true);
    try {
      await mutate(path);
      await Promise.all([refresh(), refreshDetail()]);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const latestDraft = detail?.contents.find((content) => content.status === "draft");
  const current = detail?.domain;
  const currentMetric = current ? metricByDomain.get(current.id) : undefined;
  const currentHealth = current ? healthByDomain.get(current.id) : undefined;
  const currentTelemetry = detail?.telemetryHealth[0];
  const currentRuntimeReady = Boolean(currentHealth?.fresh && currentHealth.status === "ready" && currentHealth.releaseMatches);
  const currentRuntimeHealthy = Boolean(currentRuntimeReady && currentHealth?.reliable !== false);
  const evidenceLabel = overview?.evidenceStatus === "review_ready"
    ? "Ready for scale review"
    : overview?.evidenceStatus === "insufficient_signal"
      ? "More traffic needed"
      : `${overview?.decisionGradeDays ?? 0}/${overview?.minimumReviewDays ?? 14} decision-grade days`;
  const samplingLabel = !overview
    ? "Analytics exactness is loading."
    : !overview.sampling.exactQualifiedSessions
      ? `Exact-session evidence is ${overview.sampling.exactDays}/${overview.sampling.requiredDays} complete days since ${overview.exactSessionStartDate}. Earlier sampled traffic remains visible but does not count toward review.`
      : overview.sampling.detected
        ? `Qualified sessions are exact; country and source breakdowns are sampling-adjusted estimates (maximum ×${overview.sampling.maxSampleInterval}).`
        : "Analytics remains unsampled, so qualified sessions and quality breakdowns are exact.";
  const measurementOnly = overview
    ? Object.values(overview.monetization).every((value) => value === 0)
    : null;
  const observationWindowOpen = overview?.reviewBlockers.includes("observation_window") ?? true;
  const exactUniqueKpiPending = Boolean(overview && overview.latestCompletedDate < overview.exactSessionStartDate);
  const primaryKpiLabel = exactUniqueKpiPending
    ? `Starts ${overview?.exactSessionStartDate ?? "after cutover"} UTC`
    : evidenceLabel;

  return <div className="shell">
    <aside className="rail">
      <div className="mark">DM</div>
      <nav aria-label="Primary">
        <a className={view === "portfolio" ? "active" : ""} href="#portfolio" onClick={() => setView("portfolio")}><span>01</span> Portfolio</a>
        <a className={view === "jobs" ? "active" : ""} href="#jobs" onClick={() => setView("jobs")}><span>02</span> Jobs</a>
        <a className={view === "audit" ? "active" : ""} href="#audit" onClick={() => setView("audit")}><span>03</span> Audit</a>
      </nav>
      <div className="rail-foot"><span className="pulse" /> Control plane</div>
    </aside>
    <main className="workspace" id={view}>
      <header className="topbar">
        <div><p className="kicker">DomainMonetizer / {view}</p><h1>{pageTitle}</h1></div>
        {view === "portfolio" && <div className="summary"><div><strong>{domains.length}</strong><span>in system</span></div><div><strong>{totals.live}/{overview?.health.ready ?? "—"}</strong><span>live / ready</span></div><div><strong>{formatNumber(overview?.totals.usUniqueVisitors ?? 0)}</strong><span>U.S. qualified uniques</span></div><div><strong>{overview?.decisionGradeDays ?? 0}</strong><span>decision-grade days</span></div></div>}
        {view === "jobs" && <div className="summary"><div><strong>{jobs.length}</strong><span>recent jobs</span></div><div><strong>{jobTotals.queued}</strong><span>queued</span></div><div><strong>{jobTotals.running}</strong><span>running</span></div><div><strong>{jobTotals.failed}</strong><span>failed</span></div></div>}
        {view === "audit" && <div className="summary"><div><strong>{auditEvents.length}</strong><span>recent events</span></div><div className="summary-wide"><strong>{auditEvents[0] ? formatTimestamp(auditEvents[0].occurred_at) : "—"}</strong><span>latest mutation</span></div></div>}
      </header>

      {error && <div className="error" role="alert"><span>Attention</span>{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
      {view === "portfolio" && <>
      {overview && exactUniqueKpiPending && <div className="info" role="status"><span>U.S. unique KPI</span>Measurement begins {overview.exactSessionStartDate} UTC. Traffic-quality panels can show earlier visits for context, but those visits do not count toward U.S. qualified uniques. The first completed-day result appears after the next daily rollup.</div>}
      {overview?.latestRun?.status === "failed" && <div className="error" role="alert"><span>Telemetry</span>Latest daily rollup failed for {overview.latestRun.metric_date}: {overview.latestRun.error_message ?? "No diagnostic was recorded."}</div>}
      {overview && overview.latestRun?.status !== "failed" && !overview.rollupCoverageComplete && <div className="error" role="alert"><span>Telemetry</span>Coverage is incomplete: {overview.observedFullDays} of {overview.expectedFullDays} completed UTC days are stored. Automatic recovery is pending through {overview.latestCompletedDate}.</div>}
      {overview && !observationWindowOpen && !overview.sampling.exactQualifiedSessions && <div className="error" role="alert"><span>Exactness</span>Only {overview.sampling.exactDays} of {overview.sampling.requiredDays} exact-session days are eligible for review.</div>}
      {overview && !observationWindowOpen && overview.expectedFullDays > 0 && !overview.telemetry.pipelineVerified && <div className="error" role="alert"><span>Event pipeline</span>Trusted readiness canaries verified {overview.telemetry.verifiedDays} completed days; {overview.minimumReviewDays} are required.</div>}
      {overview && overview.health.published > 0 && overview.health.ready < overview.health.published && <div className="error" role="alert"><span>Readiness</span>{overview.health.failing ? `${overview.health.failing} tenant check${overview.health.failing === 1 ? " is" : "s are"} failing.` : "A fresh end-to-end tenant check is pending."} Stale or unchecked tenants block scale review.</div>}
      {overview && !observationWindowOpen && overview.expectedFullDays > 0 && overview.health.reliable < overview.health.published && <div className="error" role="alert"><span>Reliability</span>{overview.health.published - overview.health.reliable} tenant{overview.health.published - overview.health.reliable === 1 ? " is" : "s are"} below 95% scheduled coverage or readiness. Scale review is blocked.</div>}
      {overview && !overview.currentDaySchedule.healthy && <div className="error" role="alert"><span>Schedule</span>Today's readiness cron is out of contract: {overview.currentDaySchedule.observedChecks} checks observed, {overview.currentDaySchedule.requiredChecks} required after grace, {overview.currentDaySchedule.expectedChecks} expected by now, and {overview.currentDaySchedule.readyChecks} ready. Reconcile the current day before trusting it.</div>}
      {overview && measurementOnly === false && <div className="error" role="alert"><span>Monetization</span>The measurement-only invariant is broken: {overview.monetization.activeOffers} active offers, {overview.monetization.activeRoutingPolicies} active policies, {overview.monetization.clicks} clicks, {overview.monetization.conversions} conversions, and {overview.monetization.postbacks} postbacks. Natural-traffic review is blocked.</div>}

      <section className="toolbar">
        <label><span>Filter domains</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hostname or vertical" /></label>
        <label><span>Measurement cohort</span><select value={cohort} onChange={(event) => { setCohort(event.target.value); setSelected(null); }}><option value="">All cohorts</option>{cohorts.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
        <div className="legend"><span><i className="dot live" /> Live {totals.live}</span><span><i className="dot ready" /> Runtime ready {overview?.health.ready ?? "—"}</span><span><i className={`dot ${measurementOnly === null ? "ready" : measurementOnly ? "measure" : "issue"}`} /> {measurementOnly === null ? "Measurement state loading" : measurementOnly ? "Measurement only" : "Monetization active"}</span></div>
      </section>

      <div className="content-grid">
        <section className="table-wrap" aria-busy={loading}>
          <table>
            <thead><tr><th>Hostname</th><th>Vertical</th><th>U.S. qualified uniques</th><th>Parking baseline</th><th>Status</th><th aria-label="Open" /></tr></thead>
            <tbody>{domains.map((domain) => {
              const metric = metricByDomain.get(domain.id);
              const runtimeHealth = healthByDomain.get(domain.id);
              const runtimeReady = Boolean(runtimeHealth?.fresh && runtimeHealth.status === "ready" && runtimeHealth.releaseMatches);
              const runtimeIssue = Boolean(runtimeHealth?.fresh && !runtimeReady);
              const reliabilityIssue = Boolean(runtimeHealth && !runtimeHealth.reliable);
              return <tr key={domain.id} className={selected === domain.hostname ? "selected" : ""} onClick={() => setSelected(domain.hostname)}>
              <td><div className="hostname-line"><strong>{domain.hostname}</strong><a className="site-link" href={`https://${domain.hostname}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${domain.hostname} website in a new tab`} title="Open website in new tab" onClick={(event) => event.stopPropagation()}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></svg></a></div><small>{domain.country ?? "Country unverified"}</small></td>
              <td>{domain.vertical ?? "Unclassified"}</td>
              <td><strong>{formatNumber(metric?.us_unique_visitors ?? 0)}</strong><small>{exactUniqueKpiPending ? `Daily KPI starts ${overview?.exactSessionStartDate ?? "after cutover"} UTC` : `${formatPercent(metric?.us_unique_visitors ?? 0, metric?.unique_visitors ?? 0)} of ${formatNumber(metric?.unique_visitors ?? 0)} qualified uniques`}</small></td>
              <td><strong>{formatNumber(domain.traffic30dVisitors)}</strong><small>{formatMoney(domain.parking30dRevenueUsd)} parking</small></td>
              <td><span className={`status ${domain.lifecycleStatus}`}>{statusLabels[domain.lifecycleStatus]}</span>{domain.lifecycleStatus === "published" && <small className={`tenant-state ${runtimeReady && !reliabilityIssue ? "ready" : runtimeIssue || reliabilityIssue ? "issue" : "pending"}`}>{reliabilityIssue ? "Reliability issue" : runtimeReady ? "Runtime ready" : runtimeIssue ? "Runtime issue" : "Check pending"}</small>}</td>
              <td><button className="row-open" aria-label={`Inspect ${domain.hostname}`}>→</button></td>
            </tr>})}</tbody>
          </table>
          {!loading && !domains.length && <div className="empty"><p>No domains match this view.</p><span>Import an eligible pilot set through the control API.</span></div>}
          {loading && <div className="loading-line" />}
        </section>

        <aside className="inspector" aria-live="polite">
          {current ? <>
            <div className="inspector-head"><div><p className="kicker">Domain inspector</p><h2>{current.hostname}</h2></div><span className={`status ${current.lifecycleStatus}`}>{statusLabels[current.lifecycleStatus]}</span></div>
            <div className="evidence"><p>{current.aiSummary ?? "No AI summary has been imported."}</p><dl><div><dt>Vertical</dt><dd>{current.vertical ?? "—"}</dd></div><div><dt>Country fit</dt><dd>{current.country ?? "—"}</dd></div><div><dt>30d visitors</dt><dd>{formatNumber(current.traffic30dVisitors)}</dd></div><div><dt>Registrar</dt><dd>{current.registrar ?? "—"}</dd></div></dl></div>
            <div className="runtime"><div className="runtime-head"><h3>Runtime readiness</h3><span className={`runtime-state ${currentRuntimeHealthy ? "ready" : "pending"}`}>{currentRuntimeHealthy ? "Ready" : currentHealth?.status === "unchecked" || !currentHealth ? "Unchecked" : currentHealth.reliable === false ? "Reliability issue" : "Not ready"}</span></div><dl><div><dt>HTTP</dt><dd>{currentHealth?.httpStatus ?? "—"}</dd></div><div><dt>Latency</dt><dd>{currentHealth?.latencyMs === null || currentHealth?.latencyMs === undefined ? "—" : `${currentHealth.latencyMs} ms`}</dd></div><div><dt>Release</dt><dd>{currentHealth?.releaseMatches ? "Verified" : "Unverified"}</dd></div><div><dt>Checked</dt><dd>{formatTimestamp(currentHealth?.checkedAt ?? null)}</dd></div><div><dt>Schedule coverage</dt><dd>{currentHealth?.expectedScheduledChecks ? formatPercent(currentHealth.scheduledChecks, currentHealth.expectedScheduledChecks) : "Not started"}</dd></div><div><dt>Ready checks</dt><dd>{currentHealth?.scheduledChecks ? formatPercent(currentHealth.readyScheduledChecks, currentHealth.scheduledChecks) : "Not started"}</dd></div></dl>{currentHealth?.errorMessage && <p>{currentHealth.errorMessage}</p>}<button disabled={busy} onClick={() => void action("/api/health/check")}>Check all live tenants</button></div>
            <div className="signals"><div className="signals-head"><h3>Primary audience KPI</h3><span className={`evidence-state ${overview?.evidenceStatus ?? "collecting"}`}>{primaryKpiLabel}</span></div><dl><div><dt>U.S. qualified uniques</dt><dd>{formatNumber(currentMetric?.us_unique_visitors ?? 0)}</dd></div><div><dt>All qualified uniques</dt><dd>{formatNumber(currentMetric?.unique_visitors ?? 0)}</dd></div><div><dt>U.S. % of uniques</dt><dd>{formatPercent(currentMetric?.us_unique_visitors ?? 0, currentMetric?.unique_visitors ?? 0)}</dd></div><div><dt>Engagement</dt><dd>{formatPercent(currentMetric?.human_engaged_visits ?? 0, currentMetric?.likely_human_views ?? 0)}</dd></div><div><dt>Event pipeline</dt><dd>{!overview?.expectedFullDays ? "Starts after day one" : currentTelemetry?.verified ? "Verified" : "Unverified"}</dd></div></dl><p>{exactUniqueKpiPending ? `This KPI is not populated yet. The source panels below include historical traffic context, including non-U.S. likely-human visits; none of it contributes to U.S. qualified uniques.` : "One qualified browser counts once per UTC day. Bots, previews, readiness checks, and excluded operator traffic do not count."} Clean daily-unique measurement began {overview?.exactSessionStartDate ?? "—"}. {overview?.rollupCoverageComplete ? `Coverage is complete through ${overview.rollupThrough ?? "the first completed day"}.` : `Coverage is ${overview?.observedFullDays ?? 0}/${overview?.expectedFullDays ?? 0} completed days; recovery targets ${overview?.latestCompletedDate ?? "the latest completed day"}.`} {samplingLabel}</p></div>
            <div className="quality"><div className="quality-head"><h3>Entry intent</h3><span>Privacy-safe classes</span></div>{detail.intentMetrics.length ? <ul>{detail.intentMetrics.map((intent) => <li key={`${intent.path_class}:${intent.device_class}:${intent.referrer_class}`}><div><span className="source-class human">{intent.path_class}</span><strong>{intent.referrer_class}</strong></div><p>{intent.device_class} · {formatNumber(intent.likely_human_views)} likely-human · {formatNumber(intent.views)} total views</p></li>)}</ul> : <p className="quality-empty">Legacy-path, device, and referrer classes will appear after the first clean daily rollup. Raw URLs and referrers are never stored.</p>}</div>
            <div className="quality"><div className="quality-head"><h3>Where and when</h3><span>Coarse US context</span></div>{detail.contextMetrics.length ? <ul>{detail.contextMetrics.map((context) => <li key={`${context.region_code}:${context.local_time_bucket}`}><div><span className="source-class human">{context.region_code === "XX" ? "N/A" : context.region_code}</span><strong>{formatTimeBucket(context.local_time_bucket)}</strong></div><p>{formatNumber(context.likely_human_views)} likely-human · {formatNumber(context.views)} total views</p></li>)}</ul> : <p className="quality-empty">US state and four-hour local-time buckets will appear after the first clean daily rollup. City, ZIP, coordinates, and raw timezone are never stored.</p>}</div>
            <div className="quality"><div className="quality-head"><h3>Traffic quality context</h3><span>{exactUniqueKpiPending ? "Historical; excluded from KPI" : "Source evidence, not unique KPI"}</span></div><p className="quality-note">This is a view-based source breakdown, not the U.S. qualified-unique count. A likely-human source can still be outside the U.S. or outside the daily KPI window.</p>{detail.sourceMetrics.length ? <ul>{detail.sourceMetrics.map((source) => <li key={`${source.visitor_class}:${source.classification_reason}:${source.country}:${source.asn}:${source.as_org}`}><div><span className={`source-class ${source.visitor_class}`}>{source.visitor_class}</span><strong>{source.as_org || (source.asn ? `ASN ${source.asn}` : "Network unavailable")}</strong></div><p>{source.country} · {formatReason(source.classification_reason)} · {formatNumber(source.views)} views{source.engaged_visits ? ` · ${formatNumber(source.engaged_visits)} engaged` : ""}</p></li>)}</ul> : <p className="quality-empty">Classification reason and network origin will appear after the first clean daily rollup.</p>}</div>
            <div className="checks"><h3>Eligibility evidence</h3><ul><li className={current.sourceType === "parking" ? "pass" : "fail"}>Parking type</li><li className={current.sourceStatus === "available" ? "pass" : "fail"}>Available status</li><li className={!current.sourceLabels.some((label) => label.toLowerCase() === "traffic2") ? "pass" : "fail"}>No Traffic2 label</li></ul></div>
            <div className="versions"><h3>Content and releases</h3><div className="version-row"><span>Content</span><strong>{detail?.contents[0] ? `v${detail.contents[0].version} · ${detail.contents[0].status}` : "Not generated"}</strong></div><div className="version-row"><span>Release</span><strong>{detail?.releases[0] ? `v${detail.releases[0].version} · ${detail.releases[0].status}` : "Not published"}</strong></div></div>
            <div className="actions">
              {!detail?.contents.length && <button disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/generate`)}>Generate draft</button>}
              {latestDraft && <><a className="button secondary" target="_blank" rel="noreferrer" href={`/api/content/${encodeURIComponent(latestDraft.id)}/preview`}>Preview draft</a><button disabled={busy} onClick={() => void action(`/api/content/${encodeURIComponent(latestDraft.id)}/approve`)}>Approve draft</button></>}
              {detail?.contents.some((content) => content.status === "approved") && <button disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/publish`, `Publish the approved content to ${current.hostname}? This changes the live release.`)}>{current.lifecycleStatus === "published" ? "Publish new release" : "Publish domain"}</button>}
              {current.lifecycleStatus === "published" && <button className="secondary" disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/pause`, `Pause ${current.hostname}? Visitors will receive a temporary-unavailable response until another release is published or restored.`)}>Pause domain</button>}
              {detail?.releases.filter((release) => release.id !== current.activeReleaseId).slice(0, 1).map((release) => <button key={release.id} className="text-button" disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/rollback/${encodeURIComponent(release.id)}`, `Roll back ${current.hostname} to release v${release.version}? This changes the live release.`)}>Roll back to release v{release.version}</button>)}
            </div>
          </> : <div className="inspector-empty"><span>↗</span><h2>Select a domain</h2><p>Review source evidence, content state, and publication controls.</p></div>}
        </aside>
      </div>
      </>}

      {view === "jobs" && <section className="ledger-view" aria-busy={auxiliaryLoading}>
        <div className="ledger-toolbar"><div><h2>Content generation queue</h2><p>Schema-constrained Codex drafts remain manual-review only.</p></div><button disabled={auxiliaryLoading} onClick={() => void reloadAuxiliary()}>Refresh jobs</button></div>
        <div className="ledger-table"><table><thead><tr><th>Domain</th><th>Job</th><th>Status</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td><strong>{job.hostname ?? "Domain unavailable"}</strong><small>{job.id}</small></td><td>{formatReason(job.job_type)}{job.error_message && <small className="ledger-error">{job.error_message}</small>}</td><td><span className={`status job-${job.status}`}>{job.status}</span></td><td>{formatNumber(job.attempts)}</td><td>{formatTimestamp(job.updated_at)}</td></tr>)}</tbody></table>{!auxiliaryLoading && !jobs.length && <div className="empty"><p>No generation jobs yet.</p><span>Approved pilot content was imported directly; queued Codex work will appear here.</span></div>}{auxiliaryLoading && <div className="loading-line" />}</div>
      </section>}

      {view === "audit" && <section className="ledger-view" aria-busy={auxiliaryLoading}>
        <div className="ledger-toolbar"><div><h2>Control-plane mutations</h2><p>Authenticated changes, publication decisions, and operator checks.</p></div><button disabled={auxiliaryLoading} onClick={() => void reloadAuxiliary()}>Refresh audit</button></div>
        <div className="ledger-table"><table><thead><tr><th>Action</th><th>Entity</th><th>Actor</th><th>Request</th><th>Occurred</th></tr></thead><tbody>{auditEvents.map((event) => <tr key={event.id}><td><strong>{formatReason(event.action)}</strong><small>{event.id}</small></td><td>{event.entity_type}<small>{event.entity_id}</small></td><td>{event.actor}</td><td className="mono-cell">{event.request_id ?? "—"}</td><td>{formatTimestamp(event.occurred_at)}</td></tr>)}</tbody></table>{!auxiliaryLoading && !auditEvents.length && <div className="empty"><p>No audit events recorded.</p><span>Authenticated mutations will appear here.</span></div>}{auxiliaryLoading && <div className="loading-line" />}</div>
      </section>}
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
