import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type InvokeHandler = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __MXTP_INVOKE__?: InvokeHandler;
    /** Set by the e2e harness (real Tauri shell, real invoke) to expose
     *  deterministic test affordances like fixture art stamping. */
    __MXTP_MKR_E2E__?: boolean;
  }
}

export async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window !== "undefined" && window.__MXTP_INVOKE__) {
    return window.__MXTP_INVOKE__<T>(command, args);
  }
  return tauriInvoke<T>(command, args);
}
