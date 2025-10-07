// Bull Signals (Render) — simple y directo
// - Calcula features desde KuCoin (sin API keys)
// - Pide señal al Space de Hugging Face
// - Guarda en Firebase (RTDB)
// - Vigila TP/SL cada 60s

import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { fetch } from "undici";

// ====== ENV ======
const PORT       = process.env.PORT || 8080;
const HF_SIGNAL  = process.env.HF_SIGNAL_URL || "https://crisdeyvid-bull-trade.hf.space/signal";
const FB_DB_URL  = process.env.FIREBASE_DB_URL;
const SA_JSON    = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SYMBOL     = process.env.SYMBOL || "BTCUSDT";
const KU_SYMBOL  = process.env.KU_SYMBOL || "BTC-USDT";
const THRESHOLD  = parseFloat(process.env.THRESHOLD || "0.7");

// ====== Firebase init (solo aquí) ======
if (!FB_DB_URL || !SA_JSON) {
  console.error("Faltan FIREBASE_DB_URL o GOOGLE_SERVICE_ACCOUNT_JSON");
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(SA_JSON);
} catch (e) {
  console.error("GOOGLE_SERVICE_ACCOUNT_JSON inválido:", e.message);
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FB_DB_URL
});
const db = admin.database();

// ====== Express ======
const app = express();
app.use(cors());
app.use(express.json());

// ====== KuCoin utils ======
async function getKuCoinCandles(symbol = KU_SYMBOL, type = "1hour", limit = 300) {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${symbol}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`KuCoin ${r.status}`);
  const j = await r.json();
  // data: [time,open,close,high,low,volume,turnover], newest first
  const rows = (j.data || [])
    .map(a => ({
      ts: Number(a[0]) * 1000,
      open: Number(a[1]),
      close: Number(a[2]),
      high: Number(a[3]),
      low: Number(a[4]),
      vol: Number(a[5]),
    }))
    .sort((x, y) => x.ts - y.ts);
  return rows.slice(-limit);
}

function ema(series, period) {
  if (!series.length) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = series[0];
  out.push(prev);
  for (let i = 1; i < series.length; i++) {
    const v = series[i] * k + prev * (1 - k);
    out.push(v);
    prev = v;
  }
  return out;
}

function rsi(series, period = 14) {
  if (series.length < period + 1) return series.map(() => NaN);
  const gains = [], losses = [];
  for (let i = 1; i < series.length; i++) {
    const ch = series[i] - series[i - 1];
    gains.push(Math.max(ch, 0));
    losses.push(Math.max(-ch, 0));
  }
  let avgG = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgL = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = Array(period).fill(NaN);
  const first = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  out.push(first);
  for (let i = period; i < gains.length; i++) {
    avgG = (avgG * (period - 1) + gains[i]) / period;
    avgL = (avgL * (period - 1) + losses[i]) / period;
    const val = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    out.push(val);
  }
  return out;
}

function stochOsc(highs, lows, closes, kP = 14, dP = 3) {
  const k = [];
  for (let i = 0; i < closes.length; i++) {
    const s = Math.max(0, i - kP + 1);
    const hh = Math.max(...highs.slice(s, i + 1));
    const ll = Math.min(...lows.slice(s, i + 1));
    const val = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    k.push(val);
  }
  const d = [];
  for (let i = 0; i < k.length; i++) {
    const s = Math.max(0, i - dP + 1);
    const arr = k.slice(s, i + 1);
    d.push(arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  return { k, d };
}

async function buildFeatures() {
  const candles = await getKuCoinCandles(KU_SYMBOL, "1hour", 300);
  if (!candles.length) throw new Error("Sin velas");

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  const ema9  = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes, 14);
  const { k: stoch_k, d: stoch_d } = stochOsc(highs, lows, closes, 14, 3);

  const c  = closes.at(-1);
  const c1 = closes.at(-2) ?? c;
  const c5 = closes.at(-6) ?? c;

  const feat = {
    rsi14: Number(rsi14.at(-1)?.toFixed(4) ?? 0),
    ema9: Number(ema9.at(-1)?.toFixed(2) ?? 0),
    ema20: Number(ema20.at(-1)?.toFixed(2) ?? 0),
    ret1: Number(((c - c1) / c1).toFixed(6)),
    ret5: Number(((c - c5) / c5).toFixed(6)),
    stoch_k: Number(stoch_k.at(-1)?.toFixed(2) ?? 0),
    stoch_d: Number(stoch_d.at(-1)?.toFixed(2) ?? 0),
    price_gt_ema20: c > ema20.at(-1) ? 1 : 0,
    ema9_gt_ema20:  ema9.at(-1) > ema20.at(-1) ? 1 : 0,
    timestamp: Math.floor(Date.now() / 1000)
  };

  return { features: feat, lastPrice: c };
}

// ====== HuggingFace call ======
async function askHF(features, thr = THRESHOLD) {
  const r = await fetch(HF_SIGNAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ features, threshold: thr })
  });
  if (!r.ok) throw new Error(`HF ${r.status}`);
  return r.json();
}

// ====== Firebase helpers ======
const openRef   = () => db.ref(`signals/${SYMBOL}/open`);
const closedRef = () => db.ref(`signals/${SYMBOL}/closed`);

async function addOpen(payload) {
  const ref = openRef().push();
  await ref.set(payload);
  return ref.key;
}

async function closeSignal(id, exit_price, reason = "TP/SL") {
  const srcRef = openRef().child(id);
  const snap = await srcRef.get();
  if (!snap.exists()) return;

  const data = snap.val();
  data.status     = "closed";
  data.exit_price = exit_price;
  data.reason     = reason;
  data.time_close = new Date().toISOString();

  await closedRef().child(id).set(data);
  await srcRef.remove();
}

// ====== Watcher TP/SL (60s) ======
async function checkOpenSignals() {
  try {
    const snap = await openRef().get();
    if (!snap.exists()) return;
    const open = snap.val();

    const { lastPrice } = await buildFeatures();

    for (const id of Object.keys(open)) {
      const s = open[id];
      if (s.signal !== "CALL") continue;

      if (lastPrice >= s.tp_price) {
        await closeSignal(id, lastPrice, "TP");
      } else if (lastPrice <= s.sl_price) {
        await closeSignal(id, lastPrice, "SL");
      }
    }
  } catch (e) {
    console.error("Watcher error:", e.message);
  }
}
setInterval(checkOpenSignals, 60 * 1000);

// ====== Endpoints ======
app.get("/health", async (_req, res) => {
  try {
    const { lastPrice } = await buildFeatures();
    res.json({ status: "ok", symbol: SYMBOL, price: lastPrice, threshold: THRESHOLD, hf: HF_SIGNAL });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

app.get("/features-now", async (_req, res) => {
  try {
    const { features, lastPrice } = await buildFeatures();
    res.json({ symbol: SYMBOL, price: lastPrice, features });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ask", async (req, res) => {
  try {
    const leverage = Number(req.body?.leverage ?? 20);
    const { features, lastPrice } = await buildFeatures();
    const hf = await askHF(features, THRESHOLD);

    if (hf.signal !== "CALL") {
      return res.json({ noTrade: true, hf });
    }

    const tp_pct = Number(hf.tp_pct ?? 0.01);
    const sl_pct = Number(hf.sl_pct ?? 0.02);

    const entry = lastPrice;
    const tp = Number((entry * (1 + tp_pct)).toFixed(2));
    const sl = Number((entry * (1 - sl_pct)).toFixed(2));

    const payload = {
      symbol: SYMBOL,
      timeframe: "1h",
      signal: "CALL",
      probability: hf.probability,
      threshold: THRESHOLD,
      entry_price: entry,
      tp_price: tp,
      sl_price: sl,
      last_price: entry,
      leverage,
      status: "open",
      time_open: new Date().toISOString(),
      features
    };

    const id = await addOpen(payload);
    res.json({ id, payload, hf });
  } catch (e) {
    console.error("ask error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ====== Start ======
app.listen(PORT, () => console.log(`Bull worker listo en :${PORT}`));
