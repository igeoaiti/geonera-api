export type CommunicationMode = 'simplex' | 'half-duplex' | 'full-duplex'

export interface MessageEnvelope<T = unknown> {
  id: string
  mode: CommunicationMode
  type: string
  payload: T
  correlationId?: string
  occurredAt: string
}

export interface IncomingMessage {
  type: string
  payload?: unknown
  correlationId?: string
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'INVALID_MESSAGE',
  ) {
    super(message)
  }
}

export function parseIncomingMessage(value: unknown): IncomingMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('Message body must be a JSON object')
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.type !== 'string' || candidate.type.trim().length === 0) {
    throw new ProtocolError('Message type must be a non-empty string')
  }

  if (candidate.type.length > 120) {
    throw new ProtocolError('Message type must not exceed 120 characters')
  }

  if (candidate.correlationId !== undefined && typeof candidate.correlationId !== 'string') {
    throw new ProtocolError('correlationId must be a string when provided')
  }

  return {
    type: candidate.type.trim(),
    payload: candidate.payload ?? null,
    correlationId: candidate.correlationId as string | undefined,
  }
}

export function createEnvelope<T>(
  mode: CommunicationMode,
  type: string,
  payload: T,
  correlationId?: string,
): MessageEnvelope<T> {
  return {
    id: crypto.randomUUID(),
    mode,
    type,
    payload,
    ...(correlationId ? { correlationId } : {}),
    occurredAt: new Date().toISOString(),
  }
}
