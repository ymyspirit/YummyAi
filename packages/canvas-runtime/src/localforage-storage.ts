import localforage from "./storage";
import type { StateStorage } from "zustand/middleware";
export const localForageStorage: StateStorage = {
  getItem: key => localforage.getItem<string>(key),
  setItem: (key, value) => {
    const write = localforage.setItem(key, value).then(() => undefined);
    // ERP storage already reports failure and retains an explicit retry. Zustand
    // callers may ignore this promise; observing it still preserves await rejection.
    void write.catch(() => undefined);
    return write;
  },
  removeItem: key => localforage.removeItem(key),
};
