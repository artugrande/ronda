"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { RED, type Red } from "@/lib/config";

/**
 * El marco común de todas las páginas: logo flotando, header de vidrio con
 * la navegación, y footer. La home y la ronda van sobre el paisaje; las
 * docs, sobre blanco (`docs`), para leer.
 */
export function Marco({
  activo,
  docs = false,
  wallet,
  ancho = "max-w-5xl",
  red = RED,
  children,
}: {
  activo: "app" | "docs" | "ronda";
  docs?: boolean;
  /** Qué red muestra el footer. Cada pozo tiene la suya. */
  red?: Red;
  /** Lo que va a la derecha del header: el botón de wallet, si la página lo tiene. */
  wallet?: ReactNode;
  ancho?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    document.body.classList.toggle("docs-page", docs);
    return () => document.body.classList.remove("docs-page");
  }, [docs]);

  return (
    <div className="flex min-h-full flex-1 flex-col items-center px-4 pb-14 pt-5 sm:px-6">
      <div className={`flex w-full ${ancho} flex-col items-center`}>
        <Link href="/" className="pb-2 pt-3" aria-label="Zorrito">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/zorritofinallogo.png"
            alt="Zorrito"
            className="hero-logo"
            width={150}
            height={150}
          />
        </Link>

        <header className="glass mb-5 grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-[20px] px-4 py-3">
          <Link href="/" className="logo-texto">
            Zorrito
          </Link>
          <p className="header-tagline hidden truncate text-center sm:block">
            Ahorrá. Nadie pierde. Uno gana el rendimiento.
          </p>
          <div className="flex items-center gap-2">
            <nav className="flex items-center gap-1.5 sm:gap-2">
              <Link href="/" className={`nav-link ${activo === "app" ? "activo" : ""}`}>
                App
              </Link>
              <Link href="/docs" className={`nav-link ${activo === "docs" ? "activo" : ""}`}>
                Docs
              </Link>
            </nav>
            {wallet}
          </div>
        </header>

        <main className="flex w-full flex-1 flex-col gap-4">{children}</main>

        <footer className="glass mt-10 flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
          <span>Zorrito · Ahorro premiado sin pérdida de capital</span>
          <span>·</span>
          <Link href="/">App</Link>
          <span>·</span>
          <Link href="/docs">Cómo funciona</Link>
          <span>·</span>
          <a href="https://github.com/artugrande/zorrito" target="_blank" rel="noopener">
            GitHub
          </a>
          <span>·</span>
          <span className="pill pill-neutro">Stellar {red}</span>
        </footer>
      </div>
    </div>
  );
}
