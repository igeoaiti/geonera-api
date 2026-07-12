import type { MessageEnvelope } from './protocol.ts'

export type EventListener = (event: MessageEnvelope) => void

export class SimplexEventBus {
  private readonly events: MessageEnvelope[] = []
  private readonly listeners = new Set<EventListener>()

  constructor(private readonly capacity: number) {}

  publish(event: MessageEnvelope): void {
    this.events.push(event)
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity)
    }

    for (const listener of this.listeners) {
      listener(event)
    }
  }

  recent(limit = 50): MessageEnvelope[] {
    const safeLimit = Math.max(1, Math.min(limit, this.capacity))
    return this.events.slice(-safeLimit)
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
