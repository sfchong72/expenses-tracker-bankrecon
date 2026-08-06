"use client";

import type { ReactNode } from "react";

type Tab = {
  id: string;
  label: string;
  count?: number;
};

export function PageTabs({ tabs, active, onChange, label = "Page views" }: { tabs: Tab[]; active: string; onChange: (id: string) => void; label?: string }) {
  return (
    <div className="segmented-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={active === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {typeof tab.count === "number" && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatusBadge({ status, label }: { status?: string | null; label?: string }) {
  const normalized = String(status || "unknown").toLowerCase().replaceAll(" ", "_");
  return <span className={`status-badge status-${normalized}`}>{label || friendlyStatus(normalized)}</span>;
}

export function ActionGroup({ children, label = "Record actions" }: { children: ReactNode; label?: string }) {
  return <div className="record-actions" aria-label={label}>{children}</div>;
}

export function DetailDrawer({ open, title, subtitle, onClose, children, footer }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null;
  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-header">
          <div>
            <p className="eyebrow">Record details</p>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button neutral" onClick={onClose} aria-label="Close details">×</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </aside>
    </div>
  );
}

export function FieldValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field-value"><span>{label}</span><strong>{children || "—"}</strong></div>;
}

export function friendlyStatus(status: string) {
  if (["cancelled", "voided"].includes(status)) return "Void / Cancelled";
  if (status === "incomplete") return "Incomplete Information";
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
