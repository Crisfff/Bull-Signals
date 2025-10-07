// worker/firebaseAdmin.js
import fs from "fs";
import path from "path";
import admin from "firebase-admin";

/**
 * Dónde leer el Service Account:
 * - Secret File (Render): /etc/secrets/GOOGLE_SERVICE_ACCOUNT_JSON
 * - o variable de entorno GOOGLE_SERVICE_ACCOUNT_JSON (contenido JSON)
 */
function loadServiceAccount() {
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
    || "/etc/secrets/GOOGLE_SERVICE_ACCOUNT_JSON";

  let jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null;

  if (!jsonStr && fs.existsSync(filePath)) {
    jsonStr = fs.readFileSync(filePath, "utf8");
  }
  if (!jsonStr) {
    throw new Error("Service Account no encontrado. Define GOOGLE_SERVICE_ACCOUNT_JSON (contenido) o monta el Secret File.");
  }

  // Algunas plataformas guardan el JSON con \n escapadas
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.private_key && typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch {
    // Si llega ruta en vez de contenido
    const altPath = path.resolve(jsonStr);
    const raw = fs.readFileSync(altPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    return parsed;
  }
}

const sa = loadServiceAccount();

// URL de tu Realtime Database (ej: https://tu-proyecto-default-rtdb.firebaseio.com)
const databaseURL = process.env.FIREBASE_DB_URL || process.env.VITE_FB_DB_URL;
if (!databaseURL) {
  throw new Error("FIREBASE_DB_URL no definida");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL,
  });
  console.log("✅ Firebase Admin inicializado");
}

export const rtdb = admin.database();
export const dbRef = (p) => rtdb.ref(p);
export default admin;
