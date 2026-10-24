"""Validate local installation using a synthetic shape; never reads customer files."""
import base64
import io
import json
import pathlib
import subprocess
import sys
from PIL import Image, ImageDraw

picture = Image.new("RGB", (320, 240), "white")
ImageDraw.Draw(picture).ellipse((70, 35, 250, 205), fill=(30, 60, 140))
buffer = io.BytesIO()
picture.save(buffer, "PNG")
request = {"imageBase64": base64.b64encode(buffer.getvalue()).decode("ascii"), "box": {"x": 0.15, "y": 0.1, "width": 0.7, "height": 0.8}, "points": [{"x": 0.5, "y": 0.5, "keep": True}]}
result = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("predict.py")), sys.argv[1]], input=json.dumps(request), capture_output=True, text=True, timeout=100, check=True)
response = json.loads(result.stdout)
mask = Image.open(io.BytesIO(base64.b64decode(response["maskPngBase64"]))).convert("L")
assert mask.size == (320, 240) and mask.getpixel((160, 120)) > 127 and mask.getpixel((0, 0)) == 0
pathlib.Path(sys.argv[1]).with_suffix(".ready").write_text("sam2.1 tiny: synthetic prediction passed\n", encoding="utf-8")
print("Synthetic segmentation passed: center retained, background removed.")
