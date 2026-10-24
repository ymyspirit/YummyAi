export function requireProductionEditorFixtureEnvironment(environment?: Record<string, string | undefined>): {
  isolatedDaily: true;
  databaseUrl: string;
  redisUrl: string;
  bucket: string;
  nonce: string;
  designFault: "unknown_pillow_cutout" | "expire_order_before_response" | undefined;
};
