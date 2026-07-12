# Geonera API

Gateway komunikasi Geonera berbasis Bun, TypeScript, dan Hono. Implementasi memprioritaskan **Simplex** untuk event ingestion, dengan dukungan **Half-Duplex** untuk pertukaran request/response terserialisasi dan **Full-Duplex** melalui WebSocket.

## Endpoints

- `POST /api/v1/simplex/events` — menerima event satu arah dan mengembalikan `202 Accepted`.
- `GET /api/v1/simplex/events` — membaca event terbaru dari buffer lokal.
- `POST /api/v1/half-duplex/exchange` — request/response bergiliran menggunakan header `x-session-id`.
- `GET /ws` — koneksi WebSocket dua arah.
- `GET /healthz` — health check.
- `GET /api/v1/capabilities` — daftar mode komunikasi yang tersedia.

## Development

```bash
bun install --frozen-lockfile
bun run dev
```

## Verification

```bash
bun run typecheck
bun test
```
