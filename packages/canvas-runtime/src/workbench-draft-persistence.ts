import type { STUDIO_IMAGE_DRAFT_KEY, STUDIO_VIDEO_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import { bindStudioDraftPersistence } from "./storage";
import { registerStudioDraftFlush } from "./studio-draft-flush";
import { createWorkbenchDraft, readDraftDocument } from "./workbench-draft";

/** The mounted view and recovery checks use the same owner-bound wiring.
 * Its lifetime is the five-tool session, rather than a mounted tool view. */
export function createStoredWorkbenchDraft(options: {
  key: typeof STUDIO_IMAGE_DRAFT_KEY | typeof STUDIO_VIDEO_DRAFT_KEY;
  owner: string;
  current: () => boolean;
  available: () => boolean;
  canSave: () => boolean;
  id: () => string;
  config: () => Record<string, string>;
}) {
  const persistence = bindStudioDraftPersistence(options.key, {
    owner: options.owner, current: options.current, canSave: options.canSave,
    onSaved: (value, editSeq) => item.confirmPersisted(readDraftDocument(value), editSeq),
    retry: () => item.retrySave(),
    onInvalidated: () => item.stop(),
  });
  const item = createWorkbenchDraft({
    current: persistence.current, canSave: options.canSave, canRetry: persistence.canRetry,
    id: options.id, config: options.config,
    load: async () => {
      if (!options.available()) throw new Error("当前创作服务尚未提供输入草稿保存 请联系管理员升级");
      return persistence.load();
    },
    stage: persistence.stage, save: persistence.save,
    onStop: () => { unregister(); persistence.release(); },
  });
  const unregister = registerStudioDraftFlush(() => item.flush());
  return item;
}
