"use client";

import Link from "next/link";
import { Toaster } from "@/components/toaster";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const links = [
  { href: "/dashboard", label: "My Agents" },
  { href: "/directory", label: "Discover" },
  { href: "/tasks", label: "Hired Tasks" },
  { href: "/profile", label: "Profile" },
];

type Session = { label: string; owner: string; agentWallet: string };

function navActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard" || pathname.startsWith("/agents");
  if (href === "/directory") return pathname === "/directory";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Shell({ children, fill = false, wide = false, stage = false }: { children: ReactNode; fill?: boolean; wide?: boolean; stage?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [themeReady, setThemeReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("muselancer-theme");
    const next = stored === "dark" ? "dark" : "light";
    setTheme(next);
    setThemeReady(true);
    document.documentElement.dataset.theme = next === "dark" ? "dark" : "";
    void fetch("/api/session")
      .then((response) => response.json())
      .then((body: { session?: Session | null }) => setSession(body.session ?? null))
      .catch(() => setSession(null));
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function chooseTheme(next: "light" | "dark") {
    setTheme(next);
    setThemeReady(true);
    document.documentElement.dataset.theme = next === "dark" ? "dark" : "";
    window.localStorage.setItem("muselancer-theme", next);
  }

  const frame = fill ? "flex min-h-0 flex-1 flex-col overflow-hidden" : stage ? "flex-1" : wide ? "frame frame-wide" : "frame";

  return (
    <div className={fill ? "flex h-dvh flex-col overflow-hidden" : "flex min-h-dvh flex-col"}>
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-icon" style={{ width: "48px", height: "32px" }}>
            <img src="/muselancer.png" alt="logo" />
          </span>
          <span className="brand-text">Muselancer</span>
        </Link>
        <button
            className="theme-dot"
            type="button"
            aria-label={themeReady ? (theme === "dark" ? "Use light theme" : "Use dark theme") : "Theme"}
            aria-pressed={themeReady ? theme === "dark" : undefined}
            onClick={() => chooseTheme(theme === "dark" ? "light" : "dark")}
          />
        <button className="menu-button" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Menu"}
        </button>
        <nav className={`desk-nav ${open ? "is-open" : ""}`} aria-label="Main">
          {links.map((link) => (
            <Link key={link.href} href={link.href} aria-current={navActive(pathname, link.href) ? "page" : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="top-actions">
          {session ? (
            <>
              <Link className="text-xs text-blue-500" href="/profile" title={session.owner}>{session.label || (session.owner)}</Link>
              <button
                className="text-xs text-[var(--muted)]"
                type="button"
                onClick={() => {
                  void fetch("/api/session", { method: "DELETE" }).finally(() => {
                    window.location.href = "/";
                  });
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <Link className="account" href="/">Sign in</Link>
          )}
        </div>
      </header>
      <main className={frame}>{children}</main>
      <Toaster />
    </div>
  );
}
