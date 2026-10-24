export class WorkflowExecutionError extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
