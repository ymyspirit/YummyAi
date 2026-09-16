// Type the adapted public boundary. The upstream drawer's script editor is not
// part of the ERP build; Vite's checked adapter removes that optional subsystem.
declare module "upstream-channel-editor" {
  import type { ModelChannel } from "@/stores/use-config-store";
  import type { ReactElement } from "react";
  export function ChannelEditorDrawer(props: {
    open: boolean; channel: ModelChannel | null;
    onSave: (channel: ModelChannel) => Promise<void>;
    onClose: () => void;
  }): ReactElement | null;
}
