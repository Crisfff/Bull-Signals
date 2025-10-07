import React, { useEffect, useState } from "react";
import { getDatabase, ref, onValue } from "firebase/database";
import { initializeApp } from "firebase/app";

// ⚙️ Configura Firebase (coloca tus valores reales en el .env)
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FB_DB_URL,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
};

// Inicializa Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export default function App() {
  const [openSignals, setOpenSignals] = useState([]);
  const [closedSignals, setClosedSignals] = useState([]);
  const [loading, setLoading] = useState(false);

  // 🧠 Suscripción en tiempo real a señales
  useEffect(() => {
    const openRef = ref(db, "signals/BTCUSDT/open");
    const closedRef = ref(db, "signals/BTCUSDT/closed");

    onValue(openRef, (snap) => {
      const val = snap.val() || {};
      const arr = Object.entries(val).map(([id, s]) => ({ id, ...s }));
      setOpenSignals(arr.reverse());
    });

    onValue(closedRef, (snap) => {
      const val = snap.val() || {};
      const arr = Object.entries(val).map(([id, s]) => ({ id, ...s }));
      setClosedSignals(arr.reverse());
    });
  }, []);

  // 🚀 Pedir señal al worker
  const pedirSenal = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${import.meta.env.VITE_WORKER_BASE}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leverage: 20 }),
      });
      const data = await res.json();
      if (data.noTrade) {
        alert("Sin señal: NO-TRADE");
      } else {
        alert(`Señal abierta: ${data.payload.signal}`);
      }
    } catch (e) {
      alert("Error al pedir señal");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4">
      <header className="flex items-center justify-between py-6">
        <h1 className="text-2xl font-bold">🐂 Bull Signals</h1>
        <button
          onClick={pedirSenal}
          disabled={loading}
          className="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl font-semibold"
        >
          {loading ? "Cargando..." : "Pedir señal"}
        </button>
      </header>

      <main className="grid md:grid-cols-2 gap-6 mt-6">
        <section>
          <h2 className="text-lg font-semibold mb-2">📈 Señales abiertas</h2>
          {openSignals.length === 0 ? (
            <p className="text-sm text-zinc-400">Ninguna señal abierta</p>
          ) : (
            <div className="space-y-3">
              {openSignals.map((s) => (
                <div
                  key={s.id}
                  className="bg-zinc-900 p-4 rounded-2xl border border-zinc-800"
                >
                  <div className="flex justify-between items-center">
                    <span className="font-semibold">{s.signal}</span>
                    <span className="text-sm text-zinc-400">
                      {s.time_open?.slice(0, 19).replace("T", " ")}
                    </span>
                  </div>
                  <p className="text-sm mt-1">
                    <span className="text-zinc-400">Entrada:</span>{" "}
                    {s.entry_price} | TP: {s.tp_price} | SL: {s.sl_price}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">✅ Cerradas</h2>
          {closedSignals.length === 0 ? (
            <p className="text-sm text-zinc-400">Nada cerrado aún</p>
          ) : (
            <div className="space-y-3">
              {closedSignals.map((s) => (
                <div
                  key={s.id}
                  className="bg-zinc-900 p-4 rounded-2xl border border-zinc-800"
                >
                  <div className="flex justify-between items-center">
                    <span className="font-semibold">{s.signal}</span>
                    <span className="text-sm text-zinc-400">
                      {s.time_close?.slice(0, 19).replace("T", " ")}
                    </span>
                  </div>
                  <p className="text-sm mt-1">
                    <span className="text-zinc-400">Salida:</span>{" "}
                    {s.exit_price} ({s.reason})
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
