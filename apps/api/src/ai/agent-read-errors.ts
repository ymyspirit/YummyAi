import { BadRequestException, ConflictException, ForbiddenException, HttpException, RequestTimeoutException } from "@nestjs/common";
import { AgentReadGatewayError } from "@yummyai/workflow-core";

/** Keep both the original Nest exception classes and their transport bodies. */
export function rethrowAgentReadError(error: unknown): never {
  if (!(error instanceof AgentReadGatewayError)) throw error;
  const body = { code: error.code, message: error.message };
  if (error.statusCode === 400) throw new BadRequestException(body);
  if (error.statusCode === 403) throw new ForbiddenException(body);
  if (error.statusCode === 408) throw new RequestTimeoutException(body);
  if (error.statusCode === 409) throw new ConflictException(body);
  throw new HttpException(body, error.statusCode);
}
