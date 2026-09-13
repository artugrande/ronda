import type { ReactNode } from "react";

export function Panel({
  titulo,
  children,
  pie,
}: {
  titulo?: string;
  children: ReactNode;
  pie?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-borde bg-panel p-4 sm:p-5">
      {titulo && (
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-tenue">
          {titulo}
        </h2>
      )}
      {children}
      {pie && <div className="mt-3 text-sm text-tenue">{pie}</div>}
    </section>
  );
}

export function Boton({
  children,
  onClick,
  disabled,
  cargando,
  variante = "principal",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  cargando?: boolean;
  variante?: "principal" | "secundario";
}) {
  const base =
    "w-full rounded-xl px-4 py-3.5 text-base font-medium transition disabled:opacity-40 disabled:cursor-not-allowed";
  const estilo =
    variante === "principal"
      ? "bg-acento text-white hover:brightness-110"
      : "border border-borde bg-transparent hover:bg-borde/40";
  return (
    <button
      onClick={onClick}
      disabled={disabled || cargando}
      className={`${base} ${estilo}`}
    >
      {cargando ? "…" : children}
    </button>
  );
}

export function Etiqueta({
  children,
  tono = "neutro",
}: {
  children: ReactNode;
  tono?: "neutro" | "ok" | "alerta";
}) {
  const tonos = {
    neutro: "text-tenue border-borde",
    ok: "text-ok border-ok/40",
    alerta: "text-alerta border-alerta/40",
  } as const;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tonos[tono]}`}
    >
      {children}
    </span>
  );
}

export function Error({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-alerta/40 bg-alerta/10 px-4 py-3 text-sm text-alerta">
      {children}
    </p>
  );
}

/** Acorta una dirección para que entre en pantalla sin perder los extremos. */
export function corta(dir: string, n = 4): string {
  return dir.length <= n * 2 + 3 ? dir : `${dir.slice(0, n)}…${dir.slice(-n)}`;
}
