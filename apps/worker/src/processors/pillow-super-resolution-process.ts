import { spawn } from "node:child_process";
import { OrderDesignError } from "@yummyai/order-design";

export type PillowUpscaleProcessInput = {
  executable: string; args: string[]; cwd: string; signal?: AbortSignal; timeoutMs: number;
};

/** No shell, captured buyer paths, inherited credentials, or detached children. */
export function runPillowUpscaleProcess(input: PillowUpscaleProcessInput): Promise<void> {
  if (input.signal?.aborted) return Promise.reject(new OrderDesignError("agent_upscale_cancelled"));
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd, env, shell: false, windowsHide: true, stdio: "ignore",
    });
    let failure: string | undefined;
    const terminate = (code: string) => {
      failure ??= code;
      // SIGKILL terminates only this child; wait for close before deleting its directory.
      child.kill("SIGKILL");
    };
    const onAbort = () => terminate("agent_upscale_cancelled");
    const timer = setTimeout(() => terminate("agent_upscale_timeout"), input.timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    child.once("error", () => { failure ??= "agent_upscale_process_failed"; });
    child.once("close", code => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (failure || code !== 0) reject(new OrderDesignError(failure ?? "agent_upscale_process_failed"));
      else resolve();
    });
  });
}
