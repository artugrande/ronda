import { corta } from "./ui";

/** El botón de wallet del header: conecta, o muestra quién está y deja salir. */
export function BotonWallet({
  yo,
  cargando,
  onConectar,
  onDesconectar,
}: {
  yo: string | null;
  cargando?: boolean;
  onConectar: () => void;
  onDesconectar?: () => void;
}) {
  if (yo) {
    return (
      <button
        className="btn-wallet conectada"
        title={`${yo}\nTocá para desconectar`}
        onClick={onDesconectar}
      >
        👛 {corta(yo)} <span className="ml-1 opacity-60">✕</span>
      </button>
    );
  }
  return (
    <button className="btn-wallet" onClick={onConectar} disabled={cargando}>
      {cargando ? "…" : "Conectar wallet"}
    </button>
  );
}
