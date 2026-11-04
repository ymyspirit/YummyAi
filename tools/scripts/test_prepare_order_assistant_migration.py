import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("prepare-order-assistant-migration.py"))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTest(unittest.TestCase):
    def fixture(self, root):
        assistant = root / "assistant"
        (assistant / "data/batches").mkdir(parents=True)
        (assistant / "data/config.json").write_text(json.dumps({"products": [], "skus": []}), encoding="utf-8")
        report = root / "report.txt"
        content = "order-id\torder-item-id\tsku\tquantity-purchased\tship-country\tproduct-name\n111-0000000-0000001\t1\tchanged-sku\t2\tCA\t\"name\twith tab\"\n111-0000000-0000002\t2\tother-sku\t1\tUS\titem\n"
        report.write_bytes(content.encode())
        identity = hashlib.sha256(hashlib.sha256(report.read_bytes()).digest() + b"Synthetic store" + b"US").hexdigest()[:24]
        items = {}
        # Deliberately different destination/marketplace: do not infer site from address.
        for number, site in [(1, "ATVPDKIKX0DER"), (2, "A2EUQ1WTGCTBG2")]:
            order = f"111-0000000-000000{number}"
            archive = root / f"{order}_{number}.zip"
            with zipfile.ZipFile(archive, "w") as file:
                file.writestr("order.json", json.dumps({"orderId": order, "orderItemId": str(number), "marketplaceId": site}))
            items[f"{order}_{number}"] = {"archive": str(archive)}
        (assistant / "data/batches" / f"{identity}.json").write_text(json.dumps({"id": identity, "store": "Synthetic store", "market": "US", "items": items}), encoding="utf-8")
        return assistant, report

    def test_site_partition_preserves_original_cells_and_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); assistant, report = self.fixture(root)
            result = migration.preview(assistant, report, "Synthetic store")
            self.assertEqual(result["archiveReady"], 2)
            output = root / "kit"; migration.write_kit(result, output)
            self.assertEqual((output / "original/report.txt").read_bytes(), report.read_bytes())
            usa = list(csv.DictReader(io.StringIO((output / "ATVPDKIKX0DER/orders-ATVPDKIKX0DER.txt").read_text(encoding="utf-8")), delimiter="\t"))
            self.assertEqual(usa[0]["ship-country"], "CA")
            self.assertEqual(usa[0]["product-name"], "name\twith tab")
            self.assertEqual(result["derivedReports"][0]["sourceSha256"], migration.sha(report.read_bytes()))
            with self.assertRaises(ValueError): migration.write_kit(result, output)

    def test_store_or_source_change_cannot_silently_select_a_batch(self):
        with tempfile.TemporaryDirectory() as temp:
            assistant, report = self.fixture(Path(temp))
            with self.assertRaises(ValueError): migration.preview(assistant, report, "Other store")
            report.write_bytes(report.read_bytes() + b"\n")
            with self.assertRaises(ValueError): migration.preview(assistant, report, "Synthetic store")

    def test_mismatched_archive_is_excluded_from_ready_intake(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); assistant, report = self.fixture(root)
            with zipfile.ZipFile(root / "111-0000000-0000001_1.zip", "w") as archive:
                archive.writestr("order.json", json.dumps({"orderId": "different", "orderItemId": "1", "marketplaceId": "ATVPDKIKX0DER"}))
            result = migration.preview(assistant, report, "Synthetic store")
            self.assertEqual(result["archiveReady"], 1)
            self.assertFalse(result["rows"][0]["archiveReady"])


if __name__ == "__main__":
    unittest.main()
