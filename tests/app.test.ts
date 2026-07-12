import { describe, expect, test } from 'bun:test'
import { createApp, createRuntime } from '../src/app.ts'
import type { ApiConfig } from '../src/config.ts'

const config: ApiConfig = {
  host: '127.0.0.1',
  port: 3001,
  eventBufferSize: 10,
  maxRequestBytes: 4096,
  wsPath: '/ws',
}

describe('geonera-api', () => {
  test('reports health', async () => {
    const app = createApp(createRuntime(config))
    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  test('accepts simplex events as the preferred communication mode', async () => {
    const app = createApp(createRuntime(config))
    const response = await app.request('/api/v1/simplex/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'market.tick.received', payload: { symbol: 'EURUSD' } }),
    })

    expect(response.status).toBe(202)
    const body = (await response.json()) as { accepted: boolean; event: { mode: string } }
    expect(body.accepted).toBe(true)
    expect(body.event.mode).toBe('simplex')
  })

  test('supports a serialized half-duplex exchange', async () => {
    const app = createApp(createRuntime(config))
    const response = await app.request('/api/v1/half-duplex/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'test-session',
      },
      body: JSON.stringify({ type: 'ping', payload: { sequence: 1 } }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { response: { mode: string; type: string } }
    expect(body.response.mode).toBe('half-duplex')
    expect(body.response.type).toBe('ping.response')
  })

  test('rejects malformed messages', async () => {
    const app = createApp(createRuntime(config))
    const response = await app.request('/api/v1/simplex/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: true }),
    })

    expect(response.status).toBe(400)
  })
})
