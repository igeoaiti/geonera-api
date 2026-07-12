import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { timing } from 'hono/timing'
import type { ApiConfig } from './config.ts'
import { HalfDuplexCoordinator, SessionBusyError } from './halfDuplex.ts'
import {
  createEnvelope,
  parseIncomingMessage,
  ProtocolError,
  type MessageEnvelope,
} from './protocol.ts'
import { SimplexEventBus } from './simplex.ts'

export interface ApiRuntime {
  config: ApiConfig
  simplex: SimplexEventBus
  halfDuplex: HalfDuplexCoordinator
}

export function createRuntime(config: ApiConfig): ApiRuntime {
  return {
    config,
    simplex: new SimplexEventBus(config.eventBufferSize),
    halfDuplex: new HalfDuplexCoordinator(),
  }
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > maxBytes) {
    throw new ProtocolError('Request body is too large', 413, 'PAYLOAD_TOO_LARGE')
  }

  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new ProtocolError('Request body is too large', 413, 'PAYLOAD_TOO_LARGE')
  }

  try {
    return JSON.parse(body)
  } catch {
    throw new ProtocolError('Request body must contain valid JSON')
  }
}

function halfDuplexResponse(type: string, payload: unknown): unknown {
  switch (type) {
    case 'ping':
      return { type: 'pong', receivedAt: new Date().toISOString(), payload }
    case 'capabilities':
      return {
        preferred: 'simplex',
        supported: ['simplex', 'half-duplex', 'full-duplex'],
      }
    default:
      return { type: `${type}.acknowledged`, accepted: true, payload }
  }
}

export function createApp(runtime: ApiRuntime): Hono {
  const app = new Hono()

  app.use('*', requestId())
  app.use('*', timing())
  app.use('*', secureHeaders())
  app.use('/api/*', cors())

  app.get('/', (c) =>
    c.json({
      service: 'geonera-api',
      status: 'ready',
      preferredCommunication: 'simplex',
    }),
  )

  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  app.get('/api/v1/capabilities', (c) =>
    c.json({
      preferred: 'simplex',
      modes: {
        simplex: { status: 'ready', endpoint: '/api/v1/simplex/events' },
        halfDuplex: { status: 'ready', endpoint: '/api/v1/half-duplex/exchange' },
        fullDuplex: { status: 'ready', endpoint: runtime.config.wsPath },
      },
    }),
  )

  app.post('/api/v1/simplex/events', async (c) => {
    const message = parseIncomingMessage(await readJson(c.req.raw, runtime.config.maxRequestBytes))
    const event = createEnvelope('simplex', message.type, message.payload, message.correlationId)
    runtime.simplex.publish(event)
    return c.json({ accepted: true, event }, 202)
  })

  app.get('/api/v1/simplex/events', (c) => {
    const requestedLimit = Number(c.req.query('limit') ?? 50)
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50
    return c.json({ events: runtime.simplex.recent(limit) })
  })

  app.post('/api/v1/half-duplex/exchange', async (c) => {
    const sessionId = c.req.header('x-session-id')?.trim()
    if (!sessionId) {
      throw new ProtocolError('x-session-id header is required', 400, 'SESSION_REQUIRED')
    }

    const message = parseIncomingMessage(await readJson(c.req.raw, runtime.config.maxRequestBytes))
    const response = await runtime.halfDuplex.exchange(sessionId, async () => {
      const requestEvent = createEnvelope(
        'half-duplex',
        message.type,
        message.payload,
        message.correlationId,
      )
      runtime.simplex.publish(requestEvent)
      return createEnvelope(
        'half-duplex',
        `${message.type}.response`,
        halfDuplexResponse(message.type, message.payload),
        requestEvent.id,
      )
    })

    return c.json({ response })
  })

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

  app.onError((error, c) => {
    if (error instanceof ProtocolError || error instanceof SessionBusyError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as 400 | 409 | 413,
      )
    }

    console.error(error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  })

  return app
}

export function publishFullDuplexMessage(
  runtime: ApiRuntime,
  value: unknown,
): MessageEnvelope {
  const message = parseIncomingMessage(value)
  const event = createEnvelope('full-duplex', message.type, message.payload, message.correlationId)
  runtime.simplex.publish(event)
  return event
}
