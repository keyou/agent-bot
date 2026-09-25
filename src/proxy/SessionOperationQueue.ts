// Serialize settings changes and turn starts across every route bound to a task.
export class SessionOperationQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.tails.set(sessionId, next);
    return next.finally(() => {
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId);
    });
  }
}
