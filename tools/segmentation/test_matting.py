"""Contract/region tests use synthetic data and a deterministic alpha predictor."""
import unittest
import numpy as np
from PIL import Image
from matting import refine, make_unknown, positions


class MattingRegions(unittest.TestCase):
    def setUp(self):
        self.mask = np.zeros((180, 240), dtype=np.uint8)
        self.mask[40:140, 70:180] = 255
        self.image = Image.new("RGB", (240, 180), "gray")

    def test_automatic_band_preserves_core_and_distant_background(self):
        output = refine(self.image, self.mask, 0.02, [], lambda image, trimap: np.full((image.height, image.width), 0.5))
        self.assertEqual(output[80, 100], 255)
        self.assertEqual(output[5, 5], 0)
        self.assertEqual(output[80, 70], 128)

    def test_local_brush_can_restore_outside_old_selection_without_touching_other_edges(self):
        strokes = [{"radius": 0.08, "points": [{"x": 0.75, "y": 0.5}, {"x": 0.9, "y": 0.5}]}]
        output = refine(self.image, self.mask, 0.02, strokes, lambda image, trimap: np.full((image.height, image.width), 0.25))
        unknown = make_unknown(self.mask, 0.02, strokes)
        np.testing.assert_array_equal(output[~unknown], self.mask[~unknown])
        self.assertEqual(output[90, 200], 64)
        self.assertEqual(output[40, 100], 255)

    def test_overlapping_tiles_do_not_leave_gaps_or_alpha_seams(self):
        mask = np.zeros((100, 1600), dtype=np.uint8)
        mask[20:80, 10:1590] = 255
        output = refine(Image.new("RGB", (1600, 100)), mask, 0.04, [], lambda image, trimap: np.full((image.height, image.width), 0.4))
        self.assertTrue(np.all(output[20, 10:1590] == 102))
        self.assertEqual(positions(2048)[-1] + 768, 2048)

    def test_empty_and_whole_image_masks_require_a_selection(self):
        for fill in (0, 255):
            with self.assertRaises(ValueError):
                refine(self.image, np.full_like(self.mask, fill), 0.02, [], lambda *_: None)


if __name__ == "__main__":
    unittest.main()
