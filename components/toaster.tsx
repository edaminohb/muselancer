"use client";

import { useEffect, useState } from "react";

type Notice = { id: number; kind: "ok" | "error" | "info"; text: string };

export function toast(kind: Notice["kind"], text: string) {
  window.dispatchEvent(new CustomEvent("muselancer-toast", { detail: { kind, text } }));
}

export function Toaster() {
  const [items, setItems] = useState<Notice[]>([]);

  useEffect(() => {
    function onToast(event: Event) {
      const detail = (event as CustomEvent<{ kind: Notice["kind"]; text: string }>).detail;
      if (!detail?.text) return;
      const id = Date.now() + Math.floor(Math.random() * 1000);
      setItems((current) => [...current.slice(-3), { id, kind: detail.kind, text: detail.text }]);
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 5200);
    }
    window.addEventListener("muselancer-toast", onToast);
    return () => window.removeEventListener("muselancer-toast", onToast);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((item) => (
        <p key={item.id} className={`alert shadow-[var(--shadow)] ${item.kind === "error" ? "alert-error" : item.kind === "ok" ? "alert-ok" : ""}`} role={item.kind === "error" ? "alert" : "status"}>
          {item.text}
        </p>
      ))}
    </div>
  );
}
