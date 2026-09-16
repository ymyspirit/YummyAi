import localforage from "./storage";
import type { StateStorage } from "zustand/middleware";
export const localForageStorage: StateStorage = {
  getItem: key => localforage.getItem<string>(key),
  setItem: async (key, value) => { await localforage.setItem(key, value); },
  removeItem: key => localforage.removeItem(key),
};
