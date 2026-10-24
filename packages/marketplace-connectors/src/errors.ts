import type { MarketplacePlatform } from "@yummyai/contracts";

export type MarketplaceConnectorErrorCode =
  | "authorization"
  | "validation"
  | "rate_limited"
  | "conflict"
  | "upstream_retryable"
  | "upstream_terminal";

export class MarketplaceConnectorError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly platform: MarketplacePlatform,
    readonly code: MarketplaceConnectorErrorCode,
    message: string,
    readonly retryAfterMs?: number,
    readonly outcomeUncertain = false,
  ) {
    super(message);
    this.name = "MarketplaceConnectorError";
    this.retryable = code === "rate_limited" || code === "upstream_retryable";
  }
}

export class EtsyPersonalizationSafetyError extends MarketplaceConnectorError {
  constructor(readonly reason: "unsupported" | "deletion" | "invalid_text") {
    const messages = {
      unsupported: "当前 Etsy 定制包含多问题、选项、上传、加价或尚未支持的字段。为保留完整设置，请到 Etsy 编辑；ERP 不会覆盖或关闭这些问题。",
      deletion: "Etsy 已有定制问题。ERP 不会根据未启用的草稿关闭它；如需删除，请到 Etsy 操作后重新读取。",
      invalid_text: "Etsy 定制说明最多 120 个字符，问题标题最多 45 个字符；须以字母或数字开头，且最多包含一个以三个大写字母开头的单词。请修改后重试，或到 Etsy 编辑。",
    };
    super("etsy", "validation", messages[reason]);
    this.name = "EtsyPersonalizationSafetyError";
  }
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}
