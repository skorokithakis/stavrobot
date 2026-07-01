// Thrown when the agent loop was intentionally aborted via agent.abort(). The
// queue catches this and resolves cleanly instead of retrying.
export class AbortError extends Error {
  constructor() {
    super("Agent aborted.");
    this.name = "AbortError";
  }
}

// Thrown when an agent turn ended in error after one or more messages beyond
// the initial user row had already been persisted to the database. Retrying
// such a turn would reload that progress and replay any tool side effects, so
// the queue treats this as non-retryable (like retry exhaustion). The wrapped
// message preserves the original provider error so it can still be parsed and
// surfaced to the user.
export class TurnProgressPersistedError extends Error {
  constructor(originalMessage: string) {
    super(originalMessage);
    this.name = "TurnProgressPersistedError";
  }
}
