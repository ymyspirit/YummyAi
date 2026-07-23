import { SupplierProductionOrderInputSchema, type SupplierProductionOrderInput } from "@yummyai/contracts";

export interface SupplierConnectionCredentials {
  accessToken: string;
  accountId: string;
}

export interface SupplierProductionOrderAcknowledgement {
  provider: "printify" | "printful";
  externalOrderId: string;
  status: "draft" | "submitted";
}

export interface SupplierProductionOrderConnector {
  readonly provider: "printify" | "printful";
  createDraft(input: SupplierProductionOrderInput): Promise<SupplierProductionOrderAcknowledgement>;
  submit(externalOrderId: string): Promise<SupplierProductionOrderAcknowledgement>;
}

type FetchLike = typeof fetch;

export class PrintifyProductionOrderConnector implements SupplierProductionOrderConnector {
  readonly provider = "printify" as const;

  constructor(
    private readonly credentials: SupplierConnectionCredentials,
    private readonly request: FetchLike = fetch,
    private readonly baseUrl = "https://api.printify.com",
  ) {}

  async createDraft(rawInput: SupplierProductionOrderInput): Promise<SupplierProductionOrderAcknowledgement> {
    const input = SupplierProductionOrderInputSchema.parse(rawInput);
    const response = await this.send(`/v1/shops/${encodeURIComponent(this.credentials.accountId)}/orders.json`, {
      external_id: input.externalOrderId, label: input.externalOrderId,
      line_items: input.lines.map((line) => ({
        ...(line.providerProductId ? { product_id: line.providerProductId } : {}),
        variant_id: Number(line.providerVariantId), quantity: line.quantity, external_id: line.externalLineId,
      })),
      shipping_method: normalizePrintifyShipping(input.shippingMethod), send_shipping_notification: false,
      address_to: {
        first_name: input.recipient.firstName, last_name: input.recipient.lastName,
        ...(input.recipient.company ? { company: input.recipient.company } : {}),
        address1: input.recipient.address1, ...(input.recipient.address2 ? { address2: input.recipient.address2 } : {}),
        city: input.recipient.city, region: input.recipient.region ?? "", zip: input.recipient.postalCode,
        country: input.recipient.countryCode, ...(input.recipient.email ? { email: input.recipient.email } : {}),
        ...(input.recipient.phone ? { phone: input.recipient.phone } : {}),
      },
    });
    return { provider: this.provider, externalOrderId: requireExternalId(response), status: "draft" };
  }

  async submit(externalOrderId: string): Promise<SupplierProductionOrderAcknowledgement> {
    const id = requireIdentifier(externalOrderId);
    const response = await this.send(`/v1/shops/${encodeURIComponent(this.credentials.accountId)}/orders/${encodeURIComponent(id)}/send_to_production.json`, undefined);
    return { provider: this.provider, externalOrderId: requireExternalId(response), status: "submitted" };
  }

  private async send(path: string, body: unknown) {
    const response = await this.request(`${this.baseUrl}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.credentials.accessToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Printify production order request failed (${response.status})`);
    return response.json() as Promise<unknown>;
  }
}

export class PrintfulProductionOrderConnector implements SupplierProductionOrderConnector {
  readonly provider = "printful" as const;

  constructor(
    private readonly credentials: SupplierConnectionCredentials,
    private readonly request: FetchLike = fetch,
    private readonly baseUrl = "https://api.printful.com",
  ) {}

  async createDraft(rawInput: SupplierProductionOrderInput): Promise<SupplierProductionOrderAcknowledgement> {
    const input = SupplierProductionOrderInputSchema.parse(rawInput);
    const response = await this.send("/orders?confirm=false&update_existing=true", {
      external_id: input.externalOrderId, shipping: input.shippingMethod,
      recipient: {
        name: `${input.recipient.firstName} ${input.recipient.lastName}`,
        ...(input.recipient.company ? { company: input.recipient.company } : {}), address1: input.recipient.address1,
        ...(input.recipient.address2 ? { address2: input.recipient.address2 } : {}), city: input.recipient.city,
        ...(input.recipient.region ? { state_code: input.recipient.region } : {}), country_code: input.recipient.countryCode,
        zip: input.recipient.postalCode, ...(input.recipient.email ? { email: input.recipient.email } : {}),
        ...(input.recipient.phone ? { phone: input.recipient.phone } : {}),
      },
      items: input.lines.map((line) => ({
        external_id: line.externalLineId, sync_variant_id: Number(line.providerVariantId), quantity: line.quantity,
        ...(line.fileUrls.length ? { files: line.fileUrls.map((url) => ({ type: "default", url })) } : {}),
      })),
    });
    return { provider: this.provider, externalOrderId: requirePrintfulId(response), status: "draft" };
  }

  async submit(externalOrderId: string): Promise<SupplierProductionOrderAcknowledgement> {
    const id = requireIdentifier(externalOrderId);
    const response = await this.send(`/orders/${encodeURIComponent(id)}/confirm`, undefined);
    return { provider: this.provider, externalOrderId: requirePrintfulId(response), status: "submitted" };
  }

  private async send(path: string, body: unknown) {
    const response = await this.request(`${this.baseUrl}${path}`, {
      method: "POST", headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`, "Content-Type": "application/json",
        "X-PF-Store-Id": this.credentials.accountId,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Printful production order request failed (${response.status})`);
    return response.json() as Promise<unknown>;
  }
}

function normalizePrintifyShipping(value: string) {
  const normalized = value.toLowerCase();
  if (["standard", "express", "priority", "economy"].includes(normalized)) return normalized;
  throw new TypeError("Unsupported Printify shipping method");
}

function requireIdentifier(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 300) throw new TypeError("Supplier order identifier is invalid");
  return normalized;
}

function requireExternalId(value: unknown): string {
  if (!value || typeof value !== "object" || !("id" in value)) throw new Error("Printify response did not include an order ID");
  return requireIdentifier(String(value.id));
}

function requirePrintfulId(value: unknown): string {
  if (!value || typeof value !== "object" || !("result" in value) || !value.result || typeof value.result !== "object" || !("id" in value.result)) throw new Error("Printful response did not include an order ID");
  return requireIdentifier(String(value.result.id));
}
