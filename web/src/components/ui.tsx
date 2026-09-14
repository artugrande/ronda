import type { ReactNode } from "react";

export function Panel({
  titulo,
  children,
  pie,
  className = "",
}: {
  titulo?: ReactNode;
  children: ReactNode;
  pie?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {titulo && <h2 className="card-title">{titulo}</h2>}
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
  variante?: "principal" | "secundario" | "peligro";
}) {
  const estilo = {
    principal: "btn-naranja",
    secundario: "btn-negro",
    peligro: "btn-rojo",
  }[variante];
  return (
    <button onClick={onClick} disabled={disabled || cargando} className={`btn ${estilo}`}>
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
  return <span className={`pill pill-${tono}`}>{children}</span>;
}

export function Error({ children }: { children: ReactNode }) {
  return <p className="aviso aviso-rojo">{children}</p>;
}

/** Acorta una dirección para que entre en pantalla sin perder los extremos. */
export function corta(dir: string, n = 4): string {
  return dir.length <= n * 2 + 3 ? dir : `${dir.slice(0, n)}…${dir.slice(-n)}`;
}

/** Link al explorer de la red para una cuenta, contrato o transacción. */
export function explorer(red: string, tipo: "account" | "contract" | "tx", id: string): string {
  const base = red === "mainnet" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
  return `${base}/${tipo}/${id}`;
}
