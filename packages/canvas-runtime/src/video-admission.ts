import { StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { StudioVideoPreflightSchema } from "@yummyai/contracts/pod/studio-video-directory";

/** An ephemeral display admission cannot authorize execution or cross an owner. */
export function createStudioVideoAdmission(scope: string, channel: string) {
  let owner = "", authority = "", available = false, state = { allowed: false, authority: "" };
  const listeners = new Set<() => void>();
  const publish = (allowed: boolean) => {
    if (state.allowed === allowed && state.authority === authority) return;
    state = { allowed, authority }; for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    workspace(value: unknown) {
      const parsed = StudioWorkspaceSchema.safeParse(value), workspace = parsed.success ? parsed.data : undefined;
      const next = workspace && workspace.scope === scope ? JSON.stringify([scope, workspace.contextAuthority, workspace.videoDirectoryVersion, workspace.capabilities.read, workspace.generation]) : "";
      if (next === owner) return;
      owner = next; authority = next ? workspace!.contextAuthority : "";
      available = !!next && workspace?.videoDirectoryVersion === 1 && workspace.capabilities.read && !workspace.generation.enabled;
      publish(false);
    },
    receive(message: unknown) {
      if (!message || typeof message !== "object") return;
      const value = message as Record<string, unknown>;
      if (value.type !== "studio.video-admission" || value.channel !== channel || value.scope !== scope || !authority || value.contextAuthority !== authority) return;
      if (value.admission === null) { publish(false); return; }
      const parsed = StudioVideoPreflightSchema.safeParse(value.admission);
      // Unknown, blocked or execution-bearing messages can only revoke a visit.
      publish(available && parsed.success && parsed.data.canOpen);
    },
    leave() { publish(false); },
  };
}
