# SIKEBUT WhatsApp Gateway

WhatsApp Gateway service untuk sistem SIKEBUT - notifikasi WhatsApp multi-device dengan fallback otomatis menggunakan Baileys.

## 🎯 Fitur Utama

- **Multi-Device Support**: Satu proses bisa handle banyak nomor WhatsApp
- **Auto Fallback**: Jika device utama down, otomatis pakai backup device
- **QR Code Authentication**: Scan sekali, tetap login (persistent session)
- **Priority System**: Atur prioritas device mana yang diutamakan
- **Heartbeat Monitoring**: Status device terpantau real-time ke backend Laravel
- **RESTful API**: HTTP API untuk integrasi dengan backend SIKEBUT

## 📋 Requirements

- **Node.js**: >= 20.x
- **NPM**: >= 10.x
- **Dependencies**:
  - `@whiskeysockets/baileys`: ^6.7.9
  - `express`: ^4.21.2
  - `qrcode`: ^1.5.4

## 🚀 Installation

```bash
# Clone repository
git clone https://github.com/Risfiatul20/sikebut-wa.git
cd sikebut-wa

# Install dependencies
npm install

# Copy environment template (optional)
# Atau langsung set environment variables
export WA_PORT=3001
export WA_GATEWAY_KEY="your-secret-key"
export LARAVEL_URL="http://localhost:8000"

# Start server
npm start
```

## 🔧 Configuration

Konfigurasi via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WA_PORT` | `3001` | Port server gateway |
| `WA_GATEWAY_KEY` | `sikebut-wa-key-ganti-di-produksi` | API authentication key |
| `LARAVEL_URL` | `http://localhost:8000` | Backend Laravel URL |
| `WA_HEARTBEAT_MS` | `30000` | Interval heartbeat (ms) |

**⚠️ PRODUCTION**: Wajib ganti `WA_GATEWAY_KEY` dengan value yang sama di backend Laravel!

## 📡 API Endpoints

Semua request wajib menyertakan header: `X-Gateway-Key: your-secret-key`

### Health Check
```http
GET /health
```

Response:
```json
{
  "ok": true,
  "uptime": 12345.67,
  "devices": [...]
}
```

### List Devices
```http
GET /devices
```

Response:
```json
{
  "ok": true,
  "devices": [
    {
      "id": "wa-utama",
      "nomor": "6281234567890",
      "status": "connected",
      "priority": 0,
      "lastSeen": "2026-09-10T10:30:00.000Z"
    }
  ]
}
```

### Register Device
```http
POST /devices
Content-Type: application/json

{
  "id": "wa-utama",
  "priority": 0
}
```

### Get Device Status + QR Code
```http
GET /devices/:id/qr
```

Response (jika butuh scan):
```json
{
  "ok": true,
  "status": "connecting",
  "qr": "2@...",
  "qrDataUrl": "data:image/png;base64,..."
}
```

Response (sudah connected):
```json
{
  "ok": true,
  "status": "connected",
  "nomor": "6281234567890"
}
```

### Send Message
```http
POST /send
Content-Type: application/json

{
  "nomor": "081234567890",
  "pesan": "Halo dari SIKEBUT!",
  "messageId": "optional-tracking-id"
}
```

Response:
```json
{
  "ok": true,
  "deviceId": "wa-utama",
  "nomor": "6281234567890"
}
```

### Logout Device
```http
POST /devices/:id/logout
```

### Delete Device
```http
DELETE /devices/:id
```

### Set Priority
```http
POST /devices/:id/priority
Content-Type: application/json

{
  "priority": 1
}
```

## 📁 File Structure

```
sikebut-wa/
├── server.js           # Main application
├── package.json        # NPM dependencies
├── .gitignore          # Git ignore rules
├── sessions/           # WhatsApp auth sessions (auto-created)
│   ├── wa-utama/
│   └── wa-backup/
└── priorities.json     # Device priorities (auto-created)
```

## 🔒 Security Notes

- **Internal API Only**: Jangan expose ke public internet
- **API Key Required**: Semua endpoint dilindungi `X-Gateway-Key`
- **Bind to Localhost**: Default listen di `127.0.0.1` (loopback only)
- **Session Files**: Folder `sessions/` berisi credentials WhatsApp (jangan commit ke git!)

## 🏗️ Production Deployment

### With PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start server.js --name sikebut-wa

# Enable startup script
pm2 startup
pm2 save

# Monitor
pm2 monit
pm2 logs sikebut-wa
```

### Environment Variables (Production)

```bash
export WA_PORT=3001
export WA_GATEWAY_KEY="production-secret-key-here"
export LARAVEL_URL="https://api.yourdomain.com"
export WA_HEARTBEAT_MS=30000
```

Atau buat file `.env` (jika pakai dotenv):
```env
WA_PORT=3001
WA_GATEWAY_KEY=production-secret-key-here
LARAVEL_URL=https://api.yourdomain.com
WA_HEARTBEAT_MS=30000
```

## 🔄 Integration with SIKEBUT Backend

Backend Laravel harus implement callback endpoint:

```php
// routes/api.php
Route::post('/v1/wa-gateway/callback', [WaGatewayController::class, 'callback'])
    ->middleware('wa.gateway.key'); // Custom middleware untuk verify X-Gateway-Key
```

Callback types:
- `heartbeat`: Status semua device (tiap 30 detik)
- `status`: Perubahan status device (connected, disconnected, logged_out, blocked)
- `delivery`: Hasil pengiriman pesan (success/failed)

## 📊 Device Status

| Status | Description |
|--------|-------------|
| `connecting` | Menunggu scan QR code |
| `connected` | Terhubung dan siap kirim pesan |
| `disconnected` | Koneksi terputus (auto-reconnect) |
| `logged_out` | Logout manual atau expired session |
| `blocked` | Nomor diblokir WhatsApp (403 error) |

## 🐛 Troubleshooting

### QR Code tidak muncul
- Pastikan device status `connecting`
- Wait minimal 5-10 detik untuk koneksi ke WhatsApp server
- Jika status `logged_out`, delete device dan register ulang

### Device sering disconnect
- Check koneksi internet
- Pastikan nomor WhatsApp tidak dipakai di device lain secara simultan
- Check logs: `pm2 logs sikebut-wa`

### Pesan tidak terkirim
- Verify device status `connected`
- Check format nomor (harus awali 62 atau 08)
- Check backend Laravel logs untuk error response

## 📝 License

Proprietary - SIKEBUT Project © 2026 Pemerintah Provinsi Sumatera Barat

## 👥 Maintainer

- Backend Integration: Laravel SIKEBUT Team
- WhatsApp Gateway: Baileys multi-device implementation

## 🔗 Related Repositories

- [sikebut-api](https://github.com/Risfiatul20/sikebut-api) - Laravel backend
- [sikebut-app](https://github.com/Risfiatul20/sikebut-app) - Next.js frontend

---

**Note**: Service ini adalah bagian dari ekosistem SIKEBUT (Sistem Identifikasi Kebutuhan Barang & Jasa) Provinsi Sumatera Barat.
