import { corta } from "./ui";

/** El botón de wallet del header: conecta, o muestra quién está conectado. */
export function BotonWallet({
  yo,
  cargando,
  onConectar,
}: {
  yo: string | null;
  cargando?: boolean;
  onConectar: () => void;
}) {
  if (yo) {
    return (
      <span className="btn-wallet conectada" title={yo}>
        👛 {corta(yo)}
      </span>
    );
  }
  return (
    <button className="btn-wallet" onClick={onConectar} disabled={cargando}>
      {cargando ? "…" : "Conectar wallet"}
    </button>
  );
}
