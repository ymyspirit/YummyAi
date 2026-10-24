import {
BadGatewayException,BadRequestException,ConflictException,ForbiddenException,GatewayTimeoutException,
HttpException,InternalServerErrorException,NotFoundException,RequestTimeoutException,
ServiceUnavailableException,UnauthorizedException,UnprocessableEntityException,
} from "@nestjs/common";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";

/** Only the moved original owner error is translated; unrelated failures retain their original handling. */
export function rethrowOriginalOwnerError(error: unknown): never {
  if (!(error instanceof OriginalOwnerError)) throw error;
  const body = error.getResponse();
  switch (error.status) {
    case 400: throw new BadRequestException(body);
    case 401: throw new UnauthorizedException(body);
    case 403: throw new ForbiddenException(body);
    case 404: throw new NotFoundException(body);
    case 408: throw new RequestTimeoutException(body);
    case 409: throw new ConflictException(body);
    case 422: throw new UnprocessableEntityException(body);
    case 500: throw new InternalServerErrorException(body);
    case 502: throw new BadGatewayException(body);
    case 503: throw new ServiceUnavailableException(body);
    case 504: throw new GatewayTimeoutException(body);
    default: throw new HttpException(body, error.status);
  }
}
export async function originalOwnerOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { rethrowOriginalOwnerError(error); }
}
