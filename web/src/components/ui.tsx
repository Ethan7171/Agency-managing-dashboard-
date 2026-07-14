import { ReactNode, useEffect } from "react";

export function Sparkline({ data, color = "var(--iris)", width = 96, height = 26 }:
  { data: number[]; color?: string; width?: number; height?: number }) {
  if (!data.length) return <svg className="spark" width={width} height={height} />;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = data.length === 1 ? width : (i / (data.length - 1)) * (width - 2) + 1;
    const y = height - 3 - (v / max) * (height - 6);
    return `${x},${y}`;
  });
  return (
    <svg className="spark" width={width} height={height} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.6"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Metric({ k, v, d, dir }: { k: string; v: ReactNode; d?: ReactNode; dir?: "up" | "down" }) {
  return (
    <div className="card metric">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {d != null && <div className={`d ${dir ?? ""}`}>{d}</div>}
    </div>
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export const deltaText = (d: number | null | undefined) =>
  d == null ? "—" : `${d >= 0 ? "▲" : "▼"} ${(Math.abs(d) * 100).toFixed(0)}% MoM`;
