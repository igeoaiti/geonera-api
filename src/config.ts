export interface ApiConfig {
  host: string
  port: number
  eventBufferSize: number
  maxRequestBytes: number
  wsPath: string
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): ApiConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: positiveInteger(env.PORT, 3001),
    eventBufferSize: positiveInteger(env.EVENT_BUFFER_SIZE, 200),
    maxRequestBytes: positiveInteger(env.MAX_REQUEST_BYTES, 256 * 1024),
    wsPath: env.WS_PATH?.startsWith('/') ? env.WS_PATH : '/ws',
  }
}
