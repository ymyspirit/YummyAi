import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PodArtworkOwner, type PodArtworkEnqueuer } from "@yummyai/pod-core";
import type { DatabaseConnection } from "@yummyai/database";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, POD_ARTWORK_ENQUEUER } from "../platform.tokens.js";
import { PodWorkbenchService } from "./pod-workbench.service.js";
export { assertPodArtworkInputPolicy, PodArtworkInputAssetError, type PodArtworkEnqueuer } from "@yummyai/pod-core";

@Injectable()
export class PodArtworkTaskService extends PodArtworkOwner {
  constructor(
    @Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    @Inject(POD_ARTWORK_ENQUEUER) enqueuer: PodArtworkEnqueuer,
    @Inject(PodWorkbenchService) workbench: PodWorkbenchService,
    @Inject(AuditService) audit: AuditService,
  ) {
    super(database, enqueuer, workbench, audit, {
      notFound: (message) => new NotFoundException(message),
      badRequest: (message) => new BadRequestException(message),
      unavailable: (message) => new ServiceUnavailableException(message),
    });
  }
}
