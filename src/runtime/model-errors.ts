/** Signals that a Provider can no longer continue from a previously persisted response. */
export class ModelContinuationUnavailableError extends Error {
  override readonly name = 'ModelContinuationUnavailableError'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}
