/** Thrown by matchListings when the LLM is unavailable. Scan must skip the batch (no match rows) and retry next time. */
export class MatcherUnavailableError extends Error {
  constructor(message = 'Matcher unavailable') {
    super(message)
    this.name = 'MatcherUnavailableError'
  }
}

/** Thrown by startNegotiation / stepNegotiation for caller mistakes. Routes map `code` to an HTTP status. */
export class NegotiationError extends Error {
  constructor(public readonly code: 'not_found' | 'not_ready', message: string) {
    super(message)
    this.name = 'NegotiationError'
  }
}
