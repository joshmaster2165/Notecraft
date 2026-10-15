// Page versions: OneNote's page history (imported) and Notecraft's snapshots.
// Click a version to preview it read-only; restore it from the banner.
import { useEffect, useState } from "react";
import type { Page, PageVersion } from "../model/types.ts";
import { REASON_LABEL, IDLE_MS, MAX_VERSIONS_PER_PAGE, restorePageVersion } from "../model/versions.ts";
import { store, useStore } from "../store/store.ts";
import { listVersions, loadVersion, onVersionsChanged } from "../store/versionStore.ts";
import { settlePage } from "../store/versionService.ts";
import { Icon } from "./icons.tsx";

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function summary(page: Page): string {
  let paragraphs = 0;
  let words = 0;
  for (const o of page.outlines) {
    for (const e of o.elements) {
      if (e.kind !== "text") continue;
      paragraphs++;
      words += e.runs.map((r) => r.text).join("").split(/\s+/).filter(Boolean).length;
    }
  }
  return `${words} word${words === 1 ? "" : "s"} · ${paragraphs} paragraph${paragraphs === 1 ? "" : "s"}`;
}

export function openVersion(v: PageVersion) {
  void loadVersion(v.id).then((full) => {
    if (full) store.setUi({ preview: { pageId: v.pageId, version: full }, active: null });
  });
}

export function restoreVersion(v: PageVersion) {
  settlePage(v.pageId, "before-restore");
  store.edit((d) => restorePageVersion(d, v.pageId, v.page));
  store.setUi({ preview: null });
  store.toast(`Restored the version from ${fullFmt.format(new Date(v.at))} · ⌘Z to undo`);
}

export function VersionsPanel({ page }: { page: Page }) {
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const previewId = useStore((s) => (s.ui.preview?.pageId === page.id ? s.ui.preview.version.id : null));

  useEffect(() => {
    let alive = true;
    const load = () =>
      listVersions(page.id)
        .then((v) => alive && setVersions(v))
        .catch(() => alive && setVersions([]));
    setVersions(null);
    void load();
    const off = onVersionsChanged((id) => id === page.id && void load());
    return () => {
      alive = false;
      off();
    };
  }, [page.id]);

  let lastDay = "";
  return (
    <aside className="versions" aria-label="Page versions">
      <header className="versions-head">
        <Icon.history />
        <h2>Page versions</h2>
        <button className="icon-btn" aria-label="Close page versions" onClick={() => store.setUi({ sidePanel: null, preview: null })}>
          <Icon.close />
        </button>
      </header>
      <ol className="versions-list">
        <li>
          <button className={`version${previewId ? "" : " is-current"}`} aria-current={previewId ? undefined : "true"} onClick={() => store.setUi({ preview: null })}>
            <span className="version-time">Current version</span>
            <span className="version-meta">Edited {fullFmt.format(new Date(page.modifiedAt))}</span>
            <span className="version-sum">{summary(page)}</span>
          </button>
        </li>
        {versions === null && <li className="versions-note">Loading…</li>}
        {versions?.map((v) => {
          const day = dayFmt.format(new Date(v.at));
          const header = day !== lastDay ? <li className="version-day">{day}</li> : null;
          lastDay = day;
          return [
            header,
            <li key={v.id}>
              <button className={`version${previewId === v.id ? " is-current" : ""}`} aria-current={previewId === v.id ? "true" : undefined} onClick={() => openVersion(v)}>
                <span className="version-time">
                  {timeFmt.format(new Date(v.at))}
                  {v.source === "onenote" && <span className="badge">OneNote</span>}
                </span>
                <span className="version-meta">
                  {v.author ?? "Unknown author"} · {REASON_LABEL[v.reason]}
                </span>
                <span className="version-sum">
                  {v.page.title && v.page.title !== page.title ? `“${v.page.title}” · ` : ""}
                  {summary(v.page)}
                </span>
              </button>
            </li>,
          ];
        })}
        {versions?.length === 0 && (
          <li className="versions-note">No earlier versions yet. Notecraft saves one after you stop editing for {IDLE_MS / 60000} minute and when you leave the page.</li>
        )}
      </ol>
      <p className="versions-foot">Keeps the latest {MAX_VERSIONS_PER_PAGE} Notecraft versions per page, plus any page history imported from OneNote.</p>
    </aside>
  );
}

export function PreviewBanner({ version }: { version: PageVersion }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && store.setUi({ preview: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="preview-banner" role="status">
      <Icon.history />
      <span>
        Viewing the version from <strong>{fullFmt.format(new Date(version.at))}</strong>
        {version.author ? ` by ${version.author}` : ""}
        {version.source === "onenote" ? " (OneNote history)" : ""}. It’s read-only.
      </span>
      <span className="tb-spacer" />
      <button className="btn" onClick={() => store.setUi({ preview: null })}>Back to current</button>
      <button className="btn btn-primary" onClick={() => restoreVersion(version)}>Restore this version</button>
    </div>
  );
}
