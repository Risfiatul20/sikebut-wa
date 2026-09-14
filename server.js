/**
 * SIKEBUT WA Gateway — notifikasi WhatsApp multi-device dengan fallback.
 *
 * - Node.js + Baileys (multi-session): 1 proses bisa pegang banyak nomor WA.
 * - Setiap device punya folder sesi sendiri di ./sessions/<deviceId> (scan sekali, tetap login).
 * - API internal (default port 3001) hanya dilindungi X-Gateway-Key — JANGAN dibuka ke publik.
 * - Saat kirim pesan: pilih device "connected" dengan prioritas terkecil.
 *   Kalau device utama blocked/logged_out/disconnected → otomatis coba backup berikutnya.
 * - Heartbeat tiap 30 detik ke backend Laravel (callback) supaya status device terpantau.
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const qrcode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

/* ============================================================
 * Konfigurasi (via env, punya default aman untuk dev lokal)
 * ============================================================ */
const PORT = Number(process.env.WA_PORT || 3001);
const GATEWAY_KEY = process.env.WA_GATEWAY_KEY || "sikebut-wa-key-ganti-di-produksi";
const LARAVEL_URL = (process.env.LARAVEL_URL || "http://localhost:8000").replace(/\/+$/, "");
const HEARTBEAT_MS = Number(process.env.WA_HEARTBEAT_MS || 30000);
// WA_SESSIONS_DIR: default ./sessions. Di Docker diarahkan ke volume (/app/sessions)
// supaya sesi WA tidak hilang saat container di-rebuild.
const SESSIONS_DIR = process.env.WA_SESSIONS_DIR
  ? path.resolve(process.env.WA_SESSIONS_DIR)
  : path.join(__dirname, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/* ============================================================
 * State per device
 * device = {
 *   id,             // mis. "wa-utama" / "wa-backup"
 *   nomor,          // nomor WA yang terhubung (diisi saat connected)
 *   status,         // connecting | connected | disconnected | blocked | logged_out
 *   qr,             // string QR terakhir (untuk ditampilkan di UI scan)
 *   lastSeen,       // timestamp heartbeat terakhir
 *   sock,           // instance Baileys
 * }
 * ============================================================ */
const devices = new Map();

function getDevice(id) {
  return devices.get(id) || null;
}

function listDevices() {
  return [...devices.values()].map((d) => ({
    id: d.id,
    nomor: d.nomor,
    status: d.status,
    hasQr: Boolean(d.qr),
    lastSeen: d.lastSeen,
  }));
}

/* ============================================================
 * Cadangan pesan terkirim — WAJIB untuk menjawab "retry receipt"
 * ============================================================
 * Kenapa ini ada:
 * WhatsApp bisa GAGAL mendekripsi pesan yang kita kirim (kunci sesi
 * Signal belum sinkron). Saat itu penerima mengirim "retry receipt",
 * dan Baileys menjawabnya dengan memanggil getMessage(key) untuk
 * mengambil pesan ASLI lalu mengirimnya ulang.
 *
 * Tanpa cadangan ini getMessage tak bisa menjawab, dan penerima akan
 * menampilkan "Menunggu pesan ini. Tindakan ini mungkin membutuhkan
 * waktu beberapa saat." SELAMANYA.
 *
 * (Baileys sendiri menandai ini sebagai todo: "implement a cache to
 * store the last 256 sent messages" — lihat Socket/messages-recv.js.)
 * ============================================================ */
const MAX_PESAN_TERSIMPAN = 512;
const pesanTerkirim = new Map(); // messageId -> pesan (WAMessage)

function simpanPesanTerkirim(wam) {
  const id = wam?.key?.id;
  if (!id) return;
  pesanTerkirim.set(id, wam);
  // Map menjaga urutan penyisipan → entri paling awal = paling lama.
  while (pesanTerkirim.size > MAX_PESAN_TERSIMPAN) {
    const tertua = pesanTerkirim.keys().next().value;
    pesanTerkirim.delete(tertua);
  }
}

function ambilPesanTerkirim(key) {
  return pesanTerkirim.get(key?.id);
}

/* ============================================================
 * Helper nomor WhatsApp
 * ============================================================ */
function normalizeNumber(raw) {
  let n = String(raw || "").replace(/\D/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  if (n.startsWith("8")) n = "62" + n;
  return n;
}

/* ============================================================
 * Heartbeat ke backend Laravel
 * ============================================================ */
function postLaravel(body) {
  return new Promise((resolve) => {
    const url = new URL("/api/v1/wa-gateway/callback", LARAVEL_URL);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Key": GATEWAY_KEY,
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(true));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

function sendHeartbeat() {
  postLaravel({ type: "heartbeat", devices: listDevices() }).catch(() => {});
}
setInterval(sendHeartbeat, HEARTBEAT_MS);

/* ============================================================
 * Koneksi Baileys per device
 * ============================================================ */
async function startDevice(id) {
  const existing = devices.get(id);
  // Pakai socket yang sudah ada bila masih hidup (connecting/connected) —
  // jangan buat socket baru tiap kali QR diminta (itu memperlambat QR muncul).
  if (existing && existing.sock && (existing.status === "connected" || existing.status === "connecting")) {
    return existing;
  }

  const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, id));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["SIKEBUT Gateway", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Wajib: jawab permintaan retry dari penerima yang gagal mendekripsi.
    // Tanpa ini, pesan kita menggantung di "Menunggu pesan ini..." di HP penerima.
    getMessage: async (key) => {
      const ada = ambilPesanTerkirim(key);
      // Log diagnostik: membuktikan retry benar-benar datang & kita jawab.
      console.log(
        `[SIKEBUT-WA] retry receipt diterima id=${key?.id} -> ${ada ? "DIKIRIM ULANG" : "TIDAK ADA di cadangan"}`
      );
      return ada;
    },
  });

  const device = {
    id,
    nomor: null,
    status: "connecting",
    qr: null,
    lastSeen: new Date().toISOString(),
    sock,
  };
  devices.set(id, device);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      device.qr = qr;
      device.status = "connecting";
    }

    if (connection === "open") {
      device.qr = null;
      device.status = "connected";
      device.nomor = sock.user?.id ? sock.user.id.split(":")[0] : null;
      device.lastSeen = new Date().toISOString();
      postLaravel({ type: "status", id, status: "connected", nomor: device.nomor });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      device.status = code === DisconnectReason.loggedOut ? "logged_out" : "disconnected";
      device.qr = null;
      postLaravel({ type: "status", id, status: device.status });

      // Auto reconnect (kecuali logout permanen / nomor diblokir)
      if (code === DisconnectReason.loggedOut || code === 403) {
        device.status = code === DisconnectReason.loggedOut ? "logged_out" : "blocked";
        postLaravel({ type: "status", id, status: device.status });
        return;
      }
      setTimeout(() => {
        if (devices.get(id)?.sock === sock) startDevice(id);
      }, 5000);
    }
  });

  return device;
}

async function stopDevice(id) {
  const device = devices.get(id);
  if (!device) return;
  devices.delete(id);
  try {
    device.sock?.end(new Error("logout"));
    device.sock?.ev?.removeAllListeners();
  } catch {
    /* abaikan */
  }
}

/**
 * Reset penuh satu device: matikan socket, hapus folder sesi, lalu start ulang.
 * Dipakai untuk device berstatus logged_out — sesi lama yang sudah tidak valid
 * membuat Baileys tidak mengeluarkan QR baru (koneksi stuck).
 */
async function resetDevice(id) {
  await stopDevice(id);
  fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
  return startDevice(id);
}

/* ============================================================
 * Kirim pesan dengan fallback utama → backup
 * ============================================================ */
async function sendWithFallback(nomorTujuan, pesan, { skipId } = {}) {
  const nomor = normalizeNumber(nomorTujuan);
  if (nomor.length < 10) return { ok: false, error: "Nomor tujuan tidak valid" };

  const candidates = [...devices.values()]
    .filter((d) => d.status === "connected" && d.id !== skipId)
    .sort((a, b) => priorityOf(a.id) - priorityOf(b.id));

  if (candidates.length === 0) {
    return { ok: false, error: "Tidak ada device WhatsApp yang terhubung" };
  }

  const jid = `${nomor}@s.whatsapp.net`;
  let lastError = null;

  for (const dev of candidates) {
    try {
      const terkirim = await dev.sock.sendMessage(jid, { text: pesan });
      // Simpan agar bisa dikirim ulang saat penerima minta retry (lihat getMessage).
      simpanPesanTerkirim(terkirim);
      dev.lastSeen = new Date().toISOString();
      return { ok: true, deviceId: dev.id, nomor };
    } catch (e) {
      lastError = e?.message || String(e);
    }
  }

  return { ok: false, error: lastError || "Gagal mengirim pesan" };
}

/* Prioritas device dibaca dari file konfigurasi ringan (agar admin bisa ubah tanpa restart DB).
 * Format JSON: { "wa-utama": 0, "wa-backup": 1 }
 * Default: urutan id → 0,1,2,...
 */
// WA_PRIORITY_FILE: default ./priorities.json. Di Docker diarahkan ke volume
// (/app/sessions/priorities.json) supaya urutan device ikut tersimpan.
const PRIORITY_FILE = process.env.WA_PRIORITY_FILE
  ? path.resolve(process.env.WA_PRIORITY_FILE)
  : path.join(__dirname, "priorities.json");

function priorityOf(id) {
  try {
    const p = JSON.parse(fs.readFileSync(PRIORITY_FILE, "utf8"));
    return p[id] ?? 99;
  } catch {
    return 99;
  }
}

function setPriority(id, priority) {
  let p = {};
  try {
    p = JSON.parse(fs.readFileSync(PRIORITY_FILE, "utf8"));
  } catch {
    /* file baru */
  }
  p[id] = Number(priority);
  fs.writeFileSync(PRIORITY_FILE, JSON.stringify(p, null, 2));
  return p;
}

/* ============================================================
 * HTTP API (internal)
 * ============================================================ */
const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  const key = req.get("X-Gateway-Key");
  if (key !== GATEWAY_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// Health check (untuk aaPanel / PM2 / monitoring)
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), devices: listDevices() });
});

// Daftar device + status
app.get("/devices", (req, res) => {
  res.json({
    ok: true,
    devices: listDevices().map((d) => ({ ...d, priority: priorityOf(d.id) })),
  });
});

// Daftarkan device baru (folder sesi dibuat otomatis saat pertama konek)
app.post("/devices", (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!/^[a-zA-Z0-9_-]{2,50}$/.test(id)) {
    return res.status(400).json({ ok: false, error: "id device tidak valid (hanya huruf/angka/_/-)" });
  }
  if (devices.has(id)) {
    return res.json({ ok: true, id, message: "Device sudah terdaftar" });
  }
  const priority = Number(req.body?.priority);
  if (Number.isFinite(priority)) setPriority(id, priority);

  startDevice(id).catch((e) => console.error(`[${id}] start gagal:`, e.message));
  res.json({ ok: true, id });
});

// Status detail satu device (termasuk QR bila sedang connecting)
app.get("/devices/:id", async (req, res) => {
  let device = getDevice(req.params.id);
  if (!device) {
    device = await startDevice(req.params.id).catch(() => null);
  }
  if (!device) {
    return res.status(404).json({ ok: false, error: "Device tidak ditemukan" });
  }
  res.json({
    ok: true,
    id: device.id,
    nomor: device.nomor,
    status: device.status,
    priority: priorityOf(device.id),
    hasQr: Boolean(device.qr),
    lastSeen: device.lastSeen,
  });
});

// Ambil QR untuk scan (kembalikan data URL + string mentah)
app.get("/devices/:id/qr", async (req, res) => {
  let device = getDevice(req.params.id);

  // Device berstatus logged_out: sesi lama tidak valid → reset penuh (hapus sesi
  // lama) supaya Baileys mengeluarkan QR baru. Tanpa reset ini koneksi stuck.
  if (device && device.status === "logged_out") {
    device = await resetDevice(req.params.id).catch(() => null);
  }

  if (!device) device = await startDevice(req.params.id).catch(() => null);
  if (!device) return res.status(404).json({ ok: false, error: "Device tidak ditemukan" });

  // Sudah ada QR dari event sebelumnya? Langsung kembalikan (tidak usah tunggu).
  if (device.status === "connected") {
    return res.json({ ok: true, status: "connected", nomor: device.nomor });
  }
  if (device.qr) {
    const dataUrl = await qrcode.toDataURL(device.qr, { margin: 1, width: 320 });
    return res.json({ ok: true, status: device.status, qr: device.qr, qrDataUrl: dataUrl });
  }

  // QR belum muncul — tunggu lebih lama (sampai ~30 dtk) karena koneksi Baileys
  // ke server WhatsApp kadang lambat, terutama untuk device yang baru dibuat.
  for (let i = 0; i < 60 && !device.qr && device.status !== "connected"; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (device.status === "connected") {
    return res.json({ ok: true, status: "connected", nomor: device.nomor });
  }
  if (!device.qr) {
    return res.json({ ok: true, status: device.status, qr: null, message: "QR belum tersedia, coba lagi" });
  }

  const dataUrl = await qrcode.toDataURL(device.qr, { margin: 1, width: 320 });
  res.json({ ok: true, status: device.status, qr: device.qr, qrDataUrl: dataUrl });
});

// Kirim pesan (dipakai backend Laravel)
app.post("/send", async (req, res) => {
  const { nomor, pesan, messageId } = req.body || {};
  if (!nomor || !pesan) {
    return res.status(400).json({ ok: false, error: "nomor dan pesan wajib diisi" });
  }
  const result = await sendWithFallback(nomor, pesan);
  postLaravel({
    type: "delivery",
    messageId: messageId || null,
    ok: result.ok,
    deviceId: result.deviceId || null,
    error: result.error || null,
  });
  res.status(result.ok ? 200 : 502).json({ ok: result.ok, ...result });
});

// Logout satu device (status → logged_out, sesi tetap tersimpan tapi tidak terhubung)
app.post("/devices/:id/logout", async (req, res) => {
  await stopDevice(req.params.id);
  res.json({ ok: true, message: "Device di-logout" });
});

// Hapus device beserta folder sesi (wajib scan ulang)
app.delete("/devices/:id", async (req, res) => {
  const id = req.params.id;
  await stopDevice(id);
  fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
  res.json({ ok: true, message: "Device dihapus" });
});

// Ubah prioritas device (0 = utama, 1 = backup, dst)
app.post("/devices/:id/priority", (req, res) => {
  const priority = Number(req.body?.priority);
  if (!Number.isFinite(priority)) {
    return res.status(400).json({ ok: false, error: "priority harus angka" });
  }
  const p = setPriority(req.params.id, priority);
  res.json({ ok: true, priority: p[req.params.id] });
});

// HOST: default 127.0.0.1 (aman untuk dev lokal). Di Docker set HOST=0.0.0.0
// supaya port bisa dipublish / diakses dari container lain.
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log(`[SIKEBUT-WA] Gateway jalan di http://${HOST}:${PORT}`);
  console.log(`[SIKEBUT-WA] Backend Laravel: ${LARAVEL_URL}`);

  // Auto-load sesi TERSIMPAN & VALID (creds terdaftar) → reconnect otomatis saat
  // gateway restart tanpa scan ulang. Device yang sesinya kosong/rusak TIDAK
  // di-auto-connect (biarkan menunggu QR sampai user klik Scan di halaman admin).
  const saved = fs.readdirSync(SESSIONS_DIR).filter((name) => {
    const p = path.join(SESSIONS_DIR, name);
    if (!fs.statSync(p).isDirectory()) return false;
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(p, "creds.json"), "utf8"));
      return Boolean(creds?.registered);
    } catch {
      return false; // tanpa creds.json valid → bukan sesi aktif
    }
  });
  if (saved.length > 0) {
    console.log(`[SIKEBUT-WA] Auto-connect ${saved.length} sesi valid: ${saved.join(", ")}`);
    for (const id of saved) {
      startDevice(id).catch((e) => console.error(`[${id}] auto-connect gagal:`, e.message));
    }
  } else {
    console.log("[SIKEBUT-WA] Menunggu scan QR dari halaman admin WhatsApp Gateway.");
  }

  sendHeartbeat();
});