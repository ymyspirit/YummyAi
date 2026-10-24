export class PodOwnerError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.statusCode = status;
  }
}
export interface PodOwnerErrors {
  notFound(message: string): Error;
  badRequest(message: string): Error;
  unavailable(message: string): Error;
}
export const podOwnerErrors: PodOwnerErrors = {
  notFound: (message) => new PodOwnerError("POD_NOT_FOUND", 404, message),
  badRequest: (message) => new PodOwnerError("POD_INVALID_INPUT", 400, message),
  unavailable: (message) => new PodOwnerError("POD_UNAVAILABLE", 503, message),
};
