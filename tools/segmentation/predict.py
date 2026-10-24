"""One bounded local prediction. Image bytes live only in stdin and process memory."""
import base64
import contextlib
import io
import json
import sys


def main():
    # Dependencies and model never print into the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        from PIL import Image
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        payload = json.loads(sys.stdin.buffer.read(12_000_001))
        raw = base64.b64decode(payload["imageBase64"], validate=True)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        width, height = image.size
        if width > 2048 or height > 2048:
            raise ValueError("image_limit")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        torch.set_num_threads(4)
        model = build_sam2("configs/sam2.1/sam2.1_hiera_t.yaml", sys.argv[1], device=device)
        predictor = SAM2ImagePredictor(model, max_hole_area=0, max_sprinkle_area=0)
        box = payload["box"]
        bounds = np.array([box["x"] * width, box["y"] * height, (box["x"] + box["width"]) * width, (box["y"] + box["height"]) * height])
        points = payload["points"]
        coords = np.array([[p["x"] * width, p["y"] * height] for p in points]) if points else None
        labels = np.array([int(p["keep"]) for p in points]) if points else None
        with torch.inference_mode():
            predictor.set_image(np.array(image))
            masks, scores, _ = predictor.predict(point_coords=coords, point_labels=labels, box=bounds, multimask_output=True)
        selected = masks[int(np.argmax(scores))].astype(np.uint8) * 255
        # The designer explicitly chose a region; never keep torso/background outside it.
        x0, y0, x1, y1 = bounds.astype(int)
        selected[:max(0, y0), :] = 0
        selected[min(height, y1 + 1):, :] = 0
        selected[:, :max(0, x0)] = 0
        selected[:, min(width, x1 + 1):] = 0
        if not selected.any():
            raise ValueError("empty_selection")
        output = io.BytesIO()
        Image.fromarray(selected).save(output, format="PNG", optimize=True)
    print(json.dumps({"maskPngBase64": base64.b64encode(output.getvalue()).decode("ascii"), "engine": "sam2.1", "width": width, "height": height}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Neither exception details nor customer pixels leave the subprocess.
        sys.exit(2)
