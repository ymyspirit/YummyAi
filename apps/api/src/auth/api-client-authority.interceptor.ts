import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor, UnauthorizedException } from "@nestjs/common";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { concatMap, type Observable } from "rxjs";
import { ApiClientContextLoader, type AuthenticatedRequest } from "./tenant-context.guard.js";

/** Read-only API clients are checked again after owner I/O, before any response
 * is serialized. Future write adapters must also check inside their owner TX. */
@Injectable()
export class ApiClientAuthorityInterceptor implements NestInterceptor {
  constructor(@Inject(ApiClientContextLoader) private readonly clients: ApiClientContextLoader) {}
  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = execution.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.authenticationKind !== "api_client") return next.handle();
    const admission = request.tenantContext;
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1] : undefined;
    const authority = admission && erpSessionAuthority(admission);
    return next.handle().pipe(concatMap(async value => {
      const current = token ? await this.clients.load(token) : null;
      if (!authority || !current || erpSessionAuthority(current) !== authority)
        throw new UnauthorizedException("API client authority changed during this request");
      return value;
    }));
  }
}
