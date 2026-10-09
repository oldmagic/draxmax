/** Errors with a stable code that transports map to status codes (e.g. HTTP 400/404/409). */
export class CoreError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}
