export class SessionBusyError extends Error {
  readonly status = 409
  readonly code = 'SESSION_BUSY'
}

export class HalfDuplexCoordinator {
  private readonly activeSessions = new Set<string>()

  async exchange<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
    if (this.activeSessions.has(sessionId)) {
      throw new SessionBusyError(`Session ${sessionId} is already processing a message`)
    }

    this.activeSessions.add(sessionId)
    try {
      return await operation()
    } finally {
      this.activeSessions.delete(sessionId)
    }
  }
}
