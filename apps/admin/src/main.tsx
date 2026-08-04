import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getDomain, listDomains, mutate, type DomainDetail, type DomainSummary } from "./api";
import "./styles.css";

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

function App() {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DomainDetail | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listDomains(search);
      setDomains(result);
      if (!selected && result[0]) setSelected(result[0].hostname);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load domains");
    } finally {
      setLoading(false);
    }
  }, [search, selected]);

  const refreshDetail = useCallback(async () => {
    if (!selected) return setDetail(null);
    try {
      setDetail(await getDomain(selected));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load domain");
    }
  }, [selected]);

  useEffect(() => { void refresh(); }, [search]);
  useEffect(() => { void refreshDetail(); }, [refreshDetail]);

  const totals = useMemo(() => ({
    live: domains.filter((domain) => domain.lifecycleStatus === "published").length,
    ready: domains.filter((domain) => domain.lifecycleStatus === "ready").length,
    visitors: domains.reduce((sum, domain) => sum + (domain.traffic30dVisitors ?? 0), 0),
  }), [domains]);

  const action = async (path: string) => {
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

  return <div className="shell">
    <aside className="rail">
      <div className="mark">DM</div>
      <nav aria-label="Primary">
        <a className="active" href="#portfolio"><span>01</span> Portfolio</a>
        <a href="#jobs"><span>02</span> Jobs</a>
        <a href="#audit"><span>03</span> Audit</a>
      </nav>
      <div className="rail-foot"><span className="pulse" /> Control plane</div>
    </aside>
    <main className="workspace" id="portfolio">
      <header className="topbar">
        <div><p className="kicker">DomainMonetizer</p><h1>Portfolio control</h1></div>
        <div className="summary"><div><strong>{domains.length}</strong><span>in system</span></div><div><strong>{totals.live}</strong><span>live</span></div><div><strong>{formatNumber(totals.visitors)}</strong><span>source visits / 30d</span></div></div>
      </header>

      {error && <div className="error" role="alert"><span>Attention</span>{error}<button onClick={() => setError(null)}>Dismiss</button></div>}

      <section className="toolbar">
        <label><span>Filter domains</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hostname or vertical" /></label>
        <div className="legend"><span><i className="dot live" /> Live {totals.live}</span><span><i className="dot ready" /> Ready {totals.ready}</span></div>
      </section>

      <div className="content-grid">
        <section className="table-wrap" aria-busy={loading}>
          <table>
            <thead><tr><th>Hostname</th><th>Vertical</th><th>Source traffic</th><th>Status</th><th aria-label="Open" /></tr></thead>
            <tbody>{domains.map((domain) => <tr key={domain.id} className={selected === domain.hostname ? "selected" : ""} onClick={() => setSelected(domain.hostname)}>
              <td><strong>{domain.hostname}</strong><small>{domain.country ?? "Country unverified"}</small></td>
              <td>{domain.vertical ?? "Unclassified"}</td>
              <td><strong>{formatNumber(domain.traffic30dVisitors)}</strong><small>{formatMoney(domain.parking30dRevenueUsd)} parking</small></td>
              <td><span className={`status ${domain.lifecycleStatus}`}>{statusLabels[domain.lifecycleStatus]}</span></td>
              <td><button className="row-open" aria-label={`Inspect ${domain.hostname}`}>→</button></td>
            </tr>)}</tbody>
          </table>
          {!loading && !domains.length && <div className="empty"><p>No domains match this view.</p><span>Import an eligible pilot set through the control API.</span></div>}
          {loading && <div className="loading-line" />}
        </section>

        <aside className="inspector" aria-live="polite">
          {current ? <>
            <div className="inspector-head"><div><p className="kicker">Domain inspector</p><h2>{current.hostname}</h2></div><span className={`status ${current.lifecycleStatus}`}>{statusLabels[current.lifecycleStatus]}</span></div>
            <div className="evidence"><p>{current.aiSummary ?? "No AI summary has been imported."}</p><dl><div><dt>Vertical</dt><dd>{current.vertical ?? "—"}</dd></div><div><dt>Country fit</dt><dd>{current.country ?? "—"}</dd></div><div><dt>30d visitors</dt><dd>{formatNumber(current.traffic30dVisitors)}</dd></div><div><dt>Registrar</dt><dd>{current.registrar ?? "—"}</dd></div></dl></div>
            <div className="checks"><h3>Eligibility evidence</h3><ul><li className={current.sourceType === "parking" ? "pass" : "fail"}>Parking type</li><li className={current.sourceStatus === "available" ? "pass" : "fail"}>Available status</li><li className={!current.sourceLabels.some((label) => label.toLowerCase() === "traffic2") ? "pass" : "fail"}>No Traffic2 label</li></ul></div>
            <div className="versions"><h3>Content and releases</h3><div className="version-row"><span>Content</span><strong>{detail?.contents[0] ? `v${detail.contents[0].version} · ${detail.contents[0].status}` : "Not generated"}</strong></div><div className="version-row"><span>Release</span><strong>{detail?.releases[0] ? `v${detail.releases[0].version} · ${detail.releases[0].status}` : "Not published"}</strong></div></div>
            <div className="actions">
              {!detail?.contents.length && <button disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/generate`)}>Generate draft</button>}
              {latestDraft && <><a className="button secondary" target="_blank" rel="noreferrer" href={`/api/content/${encodeURIComponent(latestDraft.id)}/preview`}>Preview draft</a><button disabled={busy} onClick={() => void action(`/api/content/${encodeURIComponent(latestDraft.id)}/approve`)}>Approve draft</button></>}
              {detail?.contents.some((content) => content.status === "approved") && <button disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/publish`)}>{current.lifecycleStatus === "published" ? "Publish new release" : "Publish domain"}</button>}
              {current.lifecycleStatus === "published" && <button className="secondary" disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/pause`)}>Pause domain</button>}
              {detail?.releases.filter((release) => release.id !== current.activeReleaseId).slice(0, 1).map((release) => <button key={release.id} className="text-button" disabled={busy} onClick={() => void action(`/api/domains/${encodeURIComponent(current.hostname)}/rollback/${encodeURIComponent(release.id)}`)}>Roll back to release v{release.version}</button>)}
            </div>
          </> : <div className="inspector-empty"><span>↗</span><h2>Select a domain</h2><p>Review source evidence, content state, and publication controls.</p></div>}
        </aside>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
