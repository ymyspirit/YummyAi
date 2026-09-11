"""Offline alpha matting. Original RGB is never modified or written to disk."""
import base64
import io
import json
import math
import sys

import numpy as np
import torch
from PIL import Image, ImageDraw


def make_unknown(mask, radius, strokes):
    height, width = mask.shape
    if strokes:
        region = Image.new("L", (width, height))
        draw = ImageDraw.Draw(region)
        for stroke in strokes:
            r = max(1, round(stroke["radius"] * min(width, height)))
            points = [(round(p["x"] * (width - 1)), round(p["y"] * (height - 1))) for p in stroke["points"]]
            if len(points) > 1:
                draw.line(points, fill=255, width=2 * r + 1, joint="curve")
            for x, y in points:
                draw.ellipse((x - r, y - r, x + r, y + r), fill=255)
        return np.asarray(region) > 0
    # Narrow band around the CURRENT edited edge, including its soft alpha.
    # A local brush can reach long whiskers outside the original SAM box.
    r = max(1, round(radius * min(width, height)))
    tensor = torch.from_numpy(mask.astype(np.float32))[None, None]
    dilated = torch.nn.functional.max_pool2d(tensor, 2 * r + 1, stride=1, padding=r)[0, 0].numpy()
    eroded = -torch.nn.functional.max_pool2d(-tensor, 2 * r + 1, stride=1, padding=r)[0, 0].numpy()
    return (dilated > 5) & (eroded < 250)


def positions(length, tile=768, overlap=192):
    if length <= tile:
        return [0]
    values = list(range(0, length - tile + 1, tile - overlap))
    if values[-1] != length - tile:
        values.append(length - tile)
    return values


def refine(image, mask, radius, strokes, predict):
    unknown = make_unknown(mask, radius, strokes)
    if not unknown.any() or not (mask >= 250).any() or not (mask <= 5).any():
        raise ValueError("matting_requires_foreground_and_background")
    trimap = np.where(mask >= 128, 255, 0).astype(np.uint8)
    trimap[unknown] = 128
    height, width = mask.shape
    # Bound attention memory; overlap prevents visible seams between tiles.
    total = np.zeros(mask.shape, dtype=np.float32)
    weights = np.zeros(mask.shape, dtype=np.float32)
    for top in positions(height):
        for left in positions(width):
            bottom, right = min(height, top + 768), min(width, left + 768)
            region = np.s_[top:bottom, left:right]
            if not unknown[region].any():
                continue
            alpha = np.clip(predict(image.crop((left, top, right, bottom)), Image.fromarray(trimap[region])), 0, 1)
            th, tw = bottom - top, right - left
            wx = np.minimum(1, np.minimum(np.arange(tw) + 1, tw - np.arange(tw)) / 96)
            wy = np.minimum(1, np.minimum(np.arange(th) + 1, th - np.arange(th)) / 96)
            weight = wy[:, None] * wx[None, :]
            total[region] += alpha[:th, :tw] * weight
            weights[region] += weight
    output = mask.copy()
    # Pixels outside the requested edge/brush remain bit-for-bit unchanged.
    output[unknown] = np.rint(total[unknown] / weights[unknown] * 255).astype(np.uint8)
    if not (output > 16).any():
        raise ValueError("empty_cutout")
    return output


def main():
    request = json.loads(sys.stdin.buffer.read(24_000_001))
    image = Image.open(io.BytesIO(base64.b64decode(request["imageBase64"], validate=True))).convert("RGB")
    mask = Image.open(io.BytesIO(base64.b64decode(request["maskPngBase64"], validate=True))).convert("L")
    if image.size != mask.size or max(image.size) > 2048 or min(image.size) < 2:
        raise ValueError("invalid_matting_dimensions")
    radius = request["radius"]
    strokes = request["strokes"]
    if not math.isfinite(radius) or not 0.001 <= radius <= 0.05 or len(strokes) > 80:
        raise ValueError("invalid_matting_region")
    if sum(len(s["points"]) for s in strokes) > 8000:
        raise ValueError("too_many_matting_points")
    for stroke in strokes:
        if not 0.0001 <= stroke["radius"] <= 0.2 or not 1 <= len(stroke["points"]) <= 2000:
            raise ValueError("invalid_matting_stroke")
        if any(not 0 <= p[axis] <= 1 for p in stroke["points"] for axis in ("x", "y")):
            raise ValueError("invalid_matting_point")
    from transformers import VitMatteImageProcessor, VitMatteForImageMatting
    torch.set_num_threads(4)
    processor = VitMatteImageProcessor.from_pretrained(sys.argv[1], local_files_only=True)
    model = VitMatteForImageMatting.from_pretrained(sys.argv[1], local_files_only=True, use_safetensors=True).eval()

    @torch.inference_mode()
    def predict(tile, trimap):
        inputs = processor(images=tile, trimaps=trimap, return_tensors="pt")
        return model(**inputs).alphas[0, 0].cpu().numpy()

    output = refine(image, np.array(mask), radius, strokes, predict)
    buffer = io.BytesIO()
    Image.fromarray(output).save(buffer, "PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    if len(encoded) > 2_000_000:
        raise ValueError("matting_output_limit")
    print(json.dumps({"maskPngBase64": encoded, "engine": "vitmatte-small", "width": image.width, "height": image.height}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Protocol errors are deliberately non-sensitive; never log customer input.
        sys.exit(2)
