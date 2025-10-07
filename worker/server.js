// worker/server.js
import express from "express";
import fetch from "node-fetch";
import { dbRef } from "./firebaseAdmin.js";

// ========= Config vía ENV =========
const SYMBOL     = process.env.VITE_SYMBOL || "BTCUSDT";         // para Firebase
const KU_SYMBOL  = "BTC-USDT";                                   // formato KuCoin
const TIMEFRAME  = process.env.VITE_TIMEFRAME || "1h";
const HF_BASE    = process.env.VITE_HF_API_BASE;                 // p.ej. 
https://crisdeyvid-bull-trade.hf.space
const THRESHOLD  = parseFloat(process.env.VITE_THRESHOLD || "0.7");
const TP_PCT     = parseFloat(process.env.VITE_TP_PCT || "0.01");
const SL_PCT     = parseFloat(process.env.VITE_SL_PCT || "0.02");
const PORT       = process.env.PORT || 3000;

// ========= Helpers =========
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const isoNow = ()=> new Date().toISOString();

// ——— Precio spot actual (KuCoin, sin API key)
async function getKucoinPrice() {
  const url = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${KU_SYMBOL}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j || j.code !== "200000") throw new Error("KuCoin price error");
  return parseFloat(j.data.price);
}

// ——— Velas KuCoin (type=1hour / 5min / 1min). Devuelve array ordenado ascendente.
async function getKucoinCandles(type = "1hour", limit = 300) {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${KU_SYMBOL}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j || j.code !== "200000") throw new Error("KuCoin candles error");
  // KuCoin devuelve más nuevas primero; invertimos y recortamos
  const rows = j.data.reverse().slice(-limit);
  // Formato: [time, open, close, high, low, volume, turnover]
  return rows.map(a => ({
    ts: Number(a[0]) * 1000,
    open: Number(a[1]),
    close: Number(a[2]),
    high: Number(a[3]),
    low:  Number(a[4]),
    volume: Number(a[5])
  }));
}

// ========= Indicadores (vanilla, sin libs) =========
function ema(series, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = series[0];
  for (let i=0;i<series.length;i++){
    const v = series[i];
    prev = i===0 ? v : (v - prev) * k + prev;
    out.push(prev);
  }
  return out;
}
function sma(series, period) {
  const out = [];
  let sum = 0;
  for (let i=0;i<series.length;i++){
    sum += series[i];
    if (i>=period) sum -= series[i-period];
    out.push(i>=period-1 ? sum/period : NaN);
  }
  return out;
}
function rsi(series, period=14) {
  let gains=0, losses=0;
  for (let i=1;i<=period;i++){
    const diff = series[i]-series[i-1];
    if (diff>=0) gains+=diff; else losses-=diff;
  }
  let avgGain = gains/period;
  let avgLoss = losses/period;
  const out = [NaN]; // primer elemento no definido
  for (let i=period+1;i<series.length;i++){
    const diff = series[i]-series[i-1];
    const gain = Math.max(diff,0);
    const loss = Math.max(-diff,0);
    avgGain = (avgGain*(period-1)+gain)/period;
    avgLoss = (avgLoss*(period-1)+loss)/period;
    const rs = avgLoss===0 ? 100 : (avgGain/avgLoss);
    const val = 100 - (100/(1+rs));
    out.push(val);
  }
  // rellenar al final con el último valor para tener mismo largo
  while (out.length < series.length) out.unshift(NaN);
  return out;
}
function pctChange(series, n=1) {
  const out = [];
  for (let i=0;i<series.length;i++){
    if (i<n) out.push(NaN);
    else out.push(series[i]/series[i-n]-1);
  }
  return out;
}
function bollinger(series, period=20, mult=2) {
  const m = sma(series, period);
  const out = { mid: [], high: [], low: [], width: [] };
  for (let i=0;i<series.length;i++){
    if (i<period-1) { out.mid.push(NaN); out.high.push(NaN); out.low.push(NaN); out.width.push(NaN); continue; }
    const start = i-period+1;
    const slice = series.slice(start, i+1);
    const mean = m[i];
    const variance = slice.reduce((s,v)=>s+(v-mean)**2,0)/period;
    const sd = Math.sqrt(variance);
    const hi = mean + mult*sd;
    const lo = mean - mult*sd;
    out.mid.push(mean); out.high.push(hi); out.low.push(lo);
    out.width.push((hi-lo)/mean);
  }
  return out;
}
function stoch(highs, lows, closes, kPeriod=14, dPeriod=3) {
  const k = [];
  for (let i=0;i<closes.length;i++){
    if (i<kPeriod-1) { k.push(NaN); continue; }
    const hh = Math.max(...highs.slice(i-kPeriod+1, i+1));
    const ll = Math.min(...lows.slice(i-kPeriod+1, i+1));
    const val = ((closes[i]-ll)/(hh-ll))*100;
    k.push(val);
  }
  const d = sma(k.filter(x=>!Number.isNaN(x)), dPeriod); // simple
  // alinear tamaños
  const kd = { k, d:[] };
  let dIdx = 0;
  for (let i=0;i<k.length;i++){
    if (Number.isNaN(k[i])) kd.d.push(NaN);
    else kd.d.push(d[dIdx++] ?? NaN);
  }
  return kd;
}

// ========= Construir features para el modelo =========
async function buildFeaturesKucoin(type="1hour") {
  const candles = await getKucoinCandles(type, 300);
  const close = candles.map(c=>c.close);
  const high  = candles.map(c=>c.high);
  const low   = candles.map(c=>c.low);

  const ema9  = ema(close, 9);
  const ema20 = ema(close, 20);
  const ema50 = ema(close, 50);
  const ema200= ema(close, 200);
  const rsi14 = rsi(close, 14);
  const ret1  = pctChange(close, 1);
  const ret5  = pctChange(close, 5);
  const bb    = bollinger(close, 20, 2);
  const { k:stoch_k, d:stoch_d } = stoch(high, low, close, 14, 3);

  const i = close.length - 1; // última vela
  const feat = {
    // nombres que tu modelo reconoce (si faltan, en el Space se completan con 0)
    rsi14:      Number(rsi14[i].toFixed(6)),
    ema9:       Number(ema9[i].toFixed(2)),
    ema20:      Number(ema20[i].toFixed(2)),
    ema50:      Number(ema50[i].toFixed(2)),
    ema200:     Number(ema200[i].toFixed(2)),
    ret1:       Number(ret1[i].toFixed(6)),
    ret5:       Number(ret5[i].toFixed(6)),
    bb_low:     Number(bb.low[i].toFixed(2)),
    bb_mid:     Number(bb.mid[i].toFixed(2)),
    bb_high:    Number(bb.high[i].toFixed(2)),
    bb_width:   Number(bb.width[i].toFixed(6)),
    stoch_k:    Number(stoch_k[i].toFixed(4)),
    stoch_d:    Number(stoch_d[i].toFixed(4)),
    hl_spread:  Number(((high[i]-low[i])/close[i]).toFixed(6)),
    price_gt_ema20: close[i] > ema20[i] ? 1 : 0,
    ema9_gt_ema20:  ema9[i]  > ema20[i] ? 1 : 0,
    ma9:  Number(ema9[i].toFixed(2)),   // alias por compatibilidad
    ma20: Number(ema20[i].toFixed(2)),
    ma50: Number(ema50[i].toFixed(2)),
    ma200:Number(ema200[i].toFixed(2)),
    macd: 0, macd_signal: 0, macd_hist: 0, // opcional si no lo usas
    vol_z: 0,
    datetime: Math.floor(candles[i].ts/1000),
    timestamp: Math.floor(Date.now()/1000)
  };
  return { features: feat, lastClose: close[i] };
}

// ========= Guardado Firebase =========
async function addOpenSignal(data) {
  const ref = dbRef(`signals/${SYMBOL}/open`).push();
  await ref.set(data);
  return ref.key;
}
async function moveToClosed(id, data) {
  await dbRef(`signals/${SYMBOL}/closed/${id}`).set(data);
  await dbRef(`signals/${SYMBOL}/open/${id}`).set(null);
}

// ========= Pedir señal al Space =========
async function askSignalToHF(features) {
  if (!HF_BASE) throw new Error("VITE_HF_API_BASE no definida");
  const r = await fetch(`${HF_BASE}/signal`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ features, threshold: THRESHOLD })
  });
  if (!r.ok) throw new Error(`HF ${r.status}`);
  return r.json();
}

// ========= Loop de cierre (cada 60s) =========
async function closeLoop() {
  try {
    const price = await getKucoinPrice();
    const snap = await dbRef(`signals/${SYMBOL}/open`).get();
    const open = snap.val() || {};
    const entries = Object.entries(open);

    for (const [id, s] of entries) {
      // actualizar último precio
      await dbRef(`signals/${SYMBOL}/open/${id}/last_price`).set(price);

      let reason = null;
      if (s.signal === "CALL") {
        if (price >= s.tp_price) reason = "TP";
        else if (price <= s.sl_price) reason = "SL";
      } else if (s.signal === "PUT") {
        if (price <= s.tp_price) reason = "TP";
        else if (price >= s.sl_price) reason = "SL";
      }
      if (reason) {
        const closed = {
          ...s,
          status: "CLOSED",
          reason,
          time_close: isoNow(),
          exit_price: price
        };
        await moveToClosed(id, closed);
        console.log(`[close] ${id} -> ${reason} @ ${price}`);
      }
    }
  } catch (e) {
    console.error("closeLoop err:", e.message);
  }
}

// ========= API HTTP =========
const app = express();
app.use(express.json());

app.get("/health", async (_, res) => {
  try {
    const price = await getKucoinPrice().catch(()=>null);
    res.json({
      ok: true,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      price,
      threshold: THRESHOLD,
      tp_pct: TP_PCT,
      sl_pct: SL_PCT,
      ts: isoNow()
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Devuelve features reales ahora mismo (útil para debug)
app.get("/features-now", async (_, res) => {
  try {
    const { features, lastClose } = await buildFeaturesKucoin("1hour");
    res.json({ ok:true, features, lastClose, ts: isoNow() });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Calcula features + pide señal a HF + guarda en Firebase (OPEN)
app.post("/ask", async (req, res) => {
  try {
    const lev = Number(req.body?.leverage || 20);

    const { features, lastClose } = await buildFeaturesKucoin("1hour");
    const hf = await askSignalToHF(features);

    if (hf.signal === "NO-TRADE") {
      return res.json({ ok:true, noTrade:true, hf });
    }

    // Entrada: último close / o Level1 actual
    const entry = lastClose || await getKucoinPrice();
    const tp = Number((hf.signal==="CALL" ? entry*(1+TP_PCT) : entry*(1-TP_PCT)).toFixed(2));
    const sl = Number((hf.signal==="CALL" ? entry*(1-SL_PCT) : entry*(1+SL_PCT)).toFixed(2));

    const payload = {
      symbol: SYMBOL, timeframe: TIMEFRAME,
      signal: hf.signal, probability: hf.probability, threshold: hf.threshold,
      entry_price: entry, last_price: entry, tp_price: tp, sl_price: sl,
      tp_pct: TP_PCT, sl_pct: SL_PCT, leverage: lev,
      time_open: isoNow(), status: "OPEN",
      source: `${HF_BASE}/signal`
    };
    const id = await addOpenSignal(payload);
    res.json({ ok:true, id, payload, hf });
  } catch (e) {
    console.error("/ask err:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Iniciar servidor y cron
app.listen(PORT, () => console.log(`Worker up on :${PORT}`));
setInterval(closeLoop, 60_000);
closeLoop();
