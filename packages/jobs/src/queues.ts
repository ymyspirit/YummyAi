export const QueueName = {
  AiAnalysis: "ai-analysis",
  Capture: "capture",
  CustomizationFileScan: "customization-file-scan",
  Export: "export",
  Media: "media",
  Metrics: "metrics",
  OrderIngestion: "order-ingestion",
  ListingSync: "listing-sync",
  Publication: "publication",
  PublicationBatch: "publication-batch",
  PublicationReconciliation: "publication-reconciliation",
  ShipmentWriteback: "shipment-writeback",
  FulfillmentAutomation: "fulfillment-automation",
  WebhookDelivery: "webhook-delivery",
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];
