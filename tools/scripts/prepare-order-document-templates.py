"""Development-only preparation of supplier templates; never copy sample order rows."""
import argparse
import hashlib
import json
import re
from copy import copy
from pathlib import Path
from openpyxl import Workbook, load_workbook

TEMPLATES = [
    ("printeque_shipping", "printeque-shipping.xlsx", "Sheet1", 2, set()),
    ("printeque_factory", "printeque-factory.xlsx", "orders", 1, {"config"}),
    ("yunexpress", "yunexpress-standard.xlsx", "标准模板", 1,
     {"产品清单", "国家简码", "多个申报信息填写说明"}),
]

def prepare(sources: dict[str, Path], output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)
    result = []
    for source_name, target_name, main, header_row, reference_sheets in TEMPLATES:
        source = load_workbook(sources[source_name], read_only=False, data_only=False)
        book = Workbook()
        book.remove(book.active)
        try:
            for original in source.worksheets:
                if original.title != main and original.title not in reference_sheets:
                    raise ValueError("Unexpected reference sheet; review before bundling")
                target = book.create_sheet(original.title)
                last = header_row + 1 if original.title == main else original.max_row
                for row in original.iter_rows(min_row=1, max_row=last):
                    for cell in row:
                        dest = target.cell(cell.row, cell.column)
                        for field in ("font", "fill", "border", "alignment", "protection"):
                            setattr(dest, field, copy(getattr(cell, field)))
                        dest.number_format = "General"
                        # The first data row retains only visual formatting.
                        if original.title == main and cell.row > header_row:
                            continue
                        value = cell.value
                        if cell.data_type == "f" or (isinstance(value, str) and re.search(r"\d{3}-\d{7}-\d{7}", value)):
                            raise ValueError("Formula or order identity in retained template cells")
                        dest.value = value
                        if isinstance(value, str):
                            dest.data_type = "s"
                for key, column in original.column_dimensions.items():
                    target.column_dimensions[key].width = column.width
                    target.column_dimensions[key].hidden = column.hidden
                for key, row in original.row_dimensions.items():
                    if key <= last:
                        target.row_dimensions[key].height = row.height
                for region in original.merged_cells.ranges:
                    if region.max_row <= (header_row if original.title == main else last):
                        target.merge_cells(str(region))
                target.freeze_panes = f"A{header_row + 1}" if original.title == main else None
            book.properties.creator = "YummyAI"
            book.properties.lastModifiedBy = "YummyAI"
            path = output_dir / target_name
            book.save(path)
            result.append({"file": target_name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                           "dataRows": 0, "headerRow": header_row, "sheet": main})
        finally:
            source.close()
            book.close()
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--printeque-shipping", type=Path, required=True)
    parser.add_argument("--printeque-factory", type=Path, required=True)
    parser.add_argument("--yunexpress", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    prepare(vars(args), args.output_dir)
