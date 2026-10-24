import { Injectable } from "@nestjs/common";
import { HttpAmazonReportArchiveGateway as SharedHttpAmazonReportArchiveGateway } from "@yummyai/order-intake";
export { AmazonArchiveAccessError, AmazonReportArchiveGateway, MAX_AMAZON_ARCHIVE_BYTES, safeAmazonArchiveUrl, isPublicAddress } from "@yummyai/order-intake";

@Injectable()
export class HttpAmazonReportArchiveGateway extends SharedHttpAmazonReportArchiveGateway {}
