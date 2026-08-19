import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writePsdUint8Array } from "ag-psd";
import sharp from "sharp";

const width = 32;
const height = 32;
const smartObjectId = "2f503dca-4d64-7c29-8e3b-2f40ba71ee10";
const rgba = (red, green, blue, alpha) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = alpha;
  }
  return { width, height, data };
};
const placeholderData = rgba(180, 52, 125, 255);
const transparentData = rgba(0, 0, 0, 0);
const placeholderPng = new Uint8Array(await sharp(Buffer.from(placeholderData.data), { raw: { width, height, channels: 4 } }).png().toBuffer());
const psd = {
  width,
  height,
  channels: 4,
  bitsPerChannel: 8,
  colorMode: 3,
  imageData: placeholderData,
  children: [
    { name: "@background", children: [{ name: "background", imageData: transparentData, left: 0, top: 0, right: width, bottom: height }] },
    {
      name: "@slot:main",
      children: [{
        name: "embedded-placeholder.png",
        imageData: placeholderData,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        placedLayer: {
          id: smartObjectId,
          type: "raster",
          transform: [0, 0, width, 0, width, height, 0, height],
          nonAffineTransform: [0, 0, width, 0, width, height, 0, height],
          width,
          height,
        },
      }],
    },
    { name: "@foreground", children: [{ name: "foreground", imageData: transparentData, left: 0, top: 0, right: width, bottom: height }] },
  ],
  linkedFiles: [{ id: smartObjectId, name: "embedded-placeholder.png", type: "png", creator: "8BIM", data: placeholderPng }],
};
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../fixtures/controlled-canvas.psd");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, writePsdUint8Array(psd, { generateThumbnail: false }));
process.stdout.write(`${target}\n`);
