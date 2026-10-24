// Type the adapted public boundary. The upstream drawer's script editor is not
// part of the ERP build; Vite's checked adapter removes that optional subsystem.
declare module "upstream-channel-editor" {
  import type { ModelChannel } from "@/stores/use-config-store";
  import type { ReactElement } from "react";
  export type SettingsChannel = Omit<ModelChannel, "apiFormat"> & { apiFormat: "openai" | "responses" };
  export function ChannelEditorDrawer(props: {
    open: boolean; channel: SettingsChannel | null;
    onSave: (channel: SettingsChannel) => Promise<void>;
    onClose: () => void;
  }): ReactElement | null;
}
