import React, { useEffect, useMemo, useState } from "react";

const BASE = import.meta.env.VITE_WORKER_BASE?.replace(/\/+$/, "") || "";

async function jsonGet(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
async function jsonPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function Badge({ children, color = "bg-zinc-700/60" }) {
  return (
    <span className={`px-2 py-0.5 rounded-lg text-xs ${color}`}>{children}</span>
  );
}

function Card({ children }) {
  return (
    <div className="bg-card/70 border border-zinc-800 rounded-2xl p-4 shadow-sm">
      {children}
    </div>
  );
}

export default function App() {
  const [loadingAsk, setLoadingAsk] = useState(false);
  const [openSignals, setOpenSignals] = useState([]);
  const [closedSignals, setClosedSignals] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");

  // Carga inicial + polling cada 10s
  useEffect(() => {
    let alive = true;

    const loadAll = async () => {
      try {
        setError("");
        const [h, open, closed] = await Promise.all([
          jsonGet("/health").catch(() => null),
          jsonGet("/signals-open"),
          jsonGet("/signals-closed"),
        ]);

        if (!alive) return;

        setHealth(h);
        setOpenSignals(normalizeList(open));
        setClosedSignals(normalizeList(closed));
      } catch (e) {
        if (!alive) return;
        setError(e.message || "Error cargando datos");
      }
    };

    loadAll();
    const iv = setInterval(loadAll, 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const pedirSenal = async () => {
    try {
      setLoadingAsk(true);
      setError("");
      const res = await jsonPost("/ask", { leverage: 20 });
      // refrescar listas tras pedir
      try {
        const [open, closed] = await Promise.all([
          jsonGet("/signals-open"),
          jsonGet("/signals-closed"),
        ]);
        setOpenSignals(normalizeList(open));
        setClosedSignals(normalizeList(closed));
      } catch {}
      if (res?.noTrade) {
        alert("No-Trade (umbral no alcanzado).");
      } else if (res?.payload?.signal) {
        alert(`✅ Señal abierta: ${res.payload.signal}`);
      } else {
        alert("Respuesta recibida.");
      }
    } catch (e) {
      setError(e.message || "Error al pedir señal");
    } finally {
      setLoadingAsk(false);
    }
  };

  const baseOk = useMemo(() => Boolean(BASE), []);

  return (
    <div className="max-w-6xl mx-auto p-4">
      <header className="flex items-center justify-between py-6">
        <div>
          <h1 className="text-2xl font-bold text-accent">🐂 Bull Signals</h1>
          <p className="text-sm text-zinc-400">
            Backend: {baseOk ? (
              <a href={BASE + "/health"} target="_blank" className="underline">
                {BASE}
              </a>
            ) : (
              <span className="text-red-400">VITE_WORKER_BASE no definido</span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {health ? (
            <Badge color="bg-emerald-700/60">OK</Badge>
          ) : (
            <Badge color="bg-yellow-700/60">SIN HEALTH</Badge>
          )}
          <button
            onClick={pedirSenal}
            disabled={loadingAsk || !baseOk}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 px-4 py-2 rounded-xl font-semibold"
          >
            {loadingAsk ? "Pidiendo..." : "Pedir señal"}
          </button>
        </div>
      </header>

      {error && (
        <Card>
          <p className="text-red-400 text-sm">⚠️ {error}</p>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <section>
          <h2 className="text-lg font-semibold mb-2">📊 Señales abiertas</h2>
          {openSignals.length === 0 ? (
            <p className="text-sm text-muted">Ninguna señal abierta</p>
          ) : (
            <div className="space-y-3">
              {openSignals.map((s) => (
                <Card key={s.id}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge color="bg-emerald-700/60">{s.signal}</Badge>
                      <span className="text-xs text-zinc-400">{s.time_open}</span>
                    </div>
                    <span className="text-xs text-zinc-400">prob: {(s.probability ?? 0).toFixed?.(3) ?? s.probability}</span>
                  </div>
                  <div className="mt-2 text-sm">
                    Entrada: <b>{fmt(s.entry_price)}</b> &nbsp;·&nbsp; TP: <b>{fmt(s.tp_price)}</b> &nbsp;·&nbsp; SL: <b>{fmt(s.sl_price)}</b>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">✅ Cerradas</h2>
          {closedSignals.length === 0 ? (
            <p className="text-sm text-muted">Nada cerrado aún</p>
          ) : (
            <div className="space-y-3">
              {closedSignals.map((s) => (
                <Card key={s.id}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge color={s.reason === "TP" ? "bg-emerald-700/60" : "bg-red-700/60"}>
                        {s.reason || "CERRADA"}
                      </Badge>
                      <span className="text-xs text-zinc-400">{s.time_close}</span>
                    </div>
                    <span className="text-xs text-zinc-400">{s.signal}</span>
                  </div>
                  <div className="mt-2 text-sm">
                    Salida: <b>{fmt(s.exit_price)}</b> &nbsp;·&nbsp; Entrada: <b>{fmt(s.entry_price)}</b>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ------- helpers -------
function fmt(v) {
  if (v === undefined || v === null) return "-";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(v);
}

function normalizeList(apiRes) {
  // Acepta {items:[...]} o {...id:obj}
  if (!apiRes) return [];
  if (Array.isArray(apiRes)) return apiRes;
  if (Array.isArray(apiRes.items)) return apiRes.items;
  const obj = apiRes;
  return Object.keys(obj)
    .map((id) => ({ id, ...obj[id] }))
    .sort((a, b) => String(b.time_open || "").localeCompare(String(a.time_open || "")));
}
