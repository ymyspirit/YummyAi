import type { ConfigurationRpc, ConfigurationSnapshot, ModelCatalogue } from "@yummyai/contracts/ai/model-configuration";
import type { ModelChannel } from "@/stores/use-config-store";
import { rpc } from "./rpc";

export const isSavedSettingsChannel = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export function settingsRequest(input: ConfigurationRpc) { return rpc<ConfigurationSnapshot>(input); }
export async function discoverChannelModels(channel: ModelChannel) {
  const result = await rpc<ModelCatalogue>({ operation: "channel.discover", ...(isSavedSettingsChannel(channel.id) ? { id: channel.id } : {}), baseUrl: channel.baseUrl, ...(channel.apiKey.trim() ? { apiKey: channel.apiKey.trim() } : {}) });
  window.dispatchEvent(new CustomEvent("settings.catalogue", { detail: { count: result.models.length, fetchedAt: result.fetchedAt, skipped: result.skipped } }));
  return result.models;
}
