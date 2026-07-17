export const QueueName = {
  AiAnalysis: "ai-analysis",
  Capture: "capture",
  Export: "export",
  Media: "media",
  Metrics: "metrics",
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];
