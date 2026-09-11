import { readFile } from "node:fs/promises";

export const BUILTIN_PRODUCTION_FONTS = [{ id: "geist_regular", name: "Geist Regular", fileName: "Geist-Regular.ttf", mediaType: "font/ttf" }] as const;
export async function getBuiltinFont(fontId: string): Promise<{ bytes: Uint8Array }> {
  if (fontId !== "geist_regular") throw new Error("unknown_builtin_font");
  return { bytes: await readFile(new URL("../fonts/Geist-Regular.ttf", import.meta.url)) };
}
