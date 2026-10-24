import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { CatalogPackageService } from "@yummyai/catalog-core";
import type { DatabaseConnection } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";

export { evaluateCompleteness, normalizeCompetitorOptionLabel, type CustomProductPackageExport } from "@yummyai/catalog-core";

@Injectable()
export class CustomProductPackageService extends CatalogPackageService {
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection, @Inject(PRIVATE_STORAGE) storage: Storage) {
    super(database, storage, {
      notFound: (message) => new NotFoundException(message),
      conflict: (message) => new ConflictException(message),
      unprocessable: (message) => new UnprocessableEntityException(message),
    });
  }
}
