import { createApp, createRuntime, publishFullDuplexMessage } from './app.ts'
import { loadConfig } from './config.ts'

interface SocketData {
  clientId: string
}

const config = loadConfig()
const runtime = createRuntime(config)
const app = createApp(runtime)

const server = Bun.serve<SocketData>({
  hostname: config.host,
  port: config.port,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === config.wsPath) {
      const clientId = request.headers.get('x-client-id') ?? crypto.randomUUID()
      if (server.upgrade(request, { data: { clientId } })) {
        return
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    return app.fetch(request)
  },
  websocket: {
    open(socket) {
      socket.subscribe('geonera.broadcast')
      socket.send(
        JSON.stringify({
          type: 'connection.ready',
          clientId: socket.data.clientId,
          mode: 'full-duplex',
        }),
      )
    },
    message(socket, rawMessage) {
      try {
        const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage)
        const value = JSON.parse(text)
        const event = publishFullDuplexMessage(runtime, value)
        socket.send(JSON.stringify({ type: 'message.ack', event }))

        if (value && typeof value === 'object' && 'broadcast' in value && value.broadcast === true) {
          server.publish('geonera.broadcast', JSON.stringify({ type: 'message.broadcast', event }))
        }
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: 'message.error',
            message: error instanceof Error ? error.message : 'Invalid WebSocket message',
          }),
        )
      }
    },
    close(socket) {
      socket.unsubscribe('geonera.broadcast')
    },
  },
})

console.info(
  JSON.stringify({
    level: 'info',
    service: 'geonera-api',
    message: 'API server started',
    url: server.url.toString(),
    preferredCommunication: 'simplex',
    websocketPath: config.wsPath,
  }),
)
