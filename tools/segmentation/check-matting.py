"""Synthetic smoke test of the installed offline model and alpha protocol."""
import base64
import io
import json
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

image = Image.new("RGB", (320, 240), (32, 70, 90))
draw = ImageDraw.Draw(image)
draw.ellipse((85, 40, 230, 205), fill=(220, 210, 170))
for offset in range(7):
    draw.line((205, 125 + offset * 3, 280, 95 + offset * 10), fill=(220, 210, 170), width=1)
mask = Image.new("L", image.size)
ImageDraw.Draw(mask).ellipse((85, 40, 230, 205), fill=255)


def encode(value):
    buffer = io.BytesIO()
    value.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


request = {"imageBase64": encode(image), "maskPngBase64": encode(mask), "radius": 0.02, "strokes": [{"radius": 0.18, "points": [{"x": 0.73, "y": 0.52}, {"x": 0.88, "y": 0.52}]}]}
result = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("matting.py")), sys.argv[1]], input=json.dumps(request), capture_output=True, text=True, timeout=95, check=True)
response = json.loads(result.stdout)
alpha = np.array(Image.open(io.BytesIO(base64.b64decode(response["maskPngBase64"]))))
assert response["engine"] == "vitmatte-small" and alpha.shape == (240, 320)
assert alpha[120, 150] == 255 and alpha[0, 0] == 0
assert ((alpha > 0) & (alpha < 255)).any(), "Expected fractional hair alpha"
assert (alpha[:, 237:285] > 32).sum() > 20, "Expected thin strands outside the coarse mask"
pathlib.Path(sys.argv[1], ".ready").write_text("vitmatte-small: synthetic strands and alpha passed\n", encoding="utf-8")
print("Offline matting passed: fine strands, fractional alpha, protected interior and background.")
