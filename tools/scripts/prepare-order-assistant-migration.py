"""Read-only legacy audit; optionally copy a verified intake kit outside source trees.

This tool never connects to a database or promotes downloads to production files.
Import the original report and ZIPs through the authenticated ERP report workspace.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import zipfile


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def regular(path: Path) -> Path:
    path = path.absolute()
    for parent in [path, *path.parents]:
        if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
            raise ValueError("Linked input/output paths are not accepted")
    if not path.is_file():
        raise ValueError("A required regular source file is missing")
    return path


def read_json(path: Path):
    return json.loads(regular(path).read_text(encoding="utf-8-sig"))


def report_rows(data: bytes) -> list[dict[str, str]]:
    if not data or len(data) > 5 * 1024 * 1024:
        raise ValueError("Report must be at most 5 MB")
    text = None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeError:
            continue
    if text is None:
        raise ValueError("Report encoding cannot be decoded")
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter="\t", strict=True)
    if not {"order-id", "order-item-id", "sku", "quantity-purchased"} <= set(reader.fieldnames or []):
        raise ValueError("Original Amazon report headers are required")
    rows, seen = [], set()
    for row in reader:
        if None in row or any(value is None for value in row.values()):
            raise ValueError("Malformed report row")
        key = row["order-id"] + "_" + row["order-item-id"]
        if not re.fullmatch(r"\d{3}-\d{7}-\d{7}_\d{1,24}", key) or key in seen:
            raise ValueError("Duplicate or invalid order/item identity")
        seen.add(key)
        quantity = int(row.get("quantity-to-ship") or (int(row["quantity-purchased"]) - int(row.get("quantity-shipped") or 0)))
        if quantity < 0 or quantity > 10000:
            raise ValueError("Invalid quantity")
        if quantity:
            rows.append({"key": key, "orderNumber": row["order-id"], "itemNumber": row["order-item-id"], "sellerSku": row["sku"], "country": row.get("ship-country", ""), "quantity": quantity})
    return rows


def check_archive(path: Path, order: str, item: str) -> tuple[str, int, str]:
    data = regular(path).read_bytes()
    if not data or len(data) > 20 * 1024 * 1024:
        raise ValueError("archive_size_limit")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 1500 or sum(entry.file_size for entry in entries) > 512 * 1024 * 1024:
            raise ValueError("archive_expansion_limit")
        documents = []
        for entry in entries:
            name = entry.filename.replace("\\", "/")
            if name.startswith("/") or ".." in PurePosixPath(name).parts or ":" in name or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1:
                raise ValueError("unsafe_archive")
            if name.lower().endswith(".json") and entry.file_size <= 5 * 1024 * 1024:
                document = json.loads(archive.read(entry).decode("utf-8-sig"))
                if isinstance(document, dict) and str(document.get("orderId", "")) == order and str(document.get("orderItemId", "")) == item:
                    documents.append(document)
        if len(documents) != 1 or archive.testzip() is not None:
            raise ValueError("archive_identity_or_crc_mismatch")
        marketplace = str(documents[0].get("marketplaceId", ""))
        if not re.fullmatch(r"[A-Z0-9]{5,40}", marketplace):
            raise ValueError("archive_marketplace_missing")
    return sha(data), len(data), marketplace


def preview(assistant: Path, report: Path, store: str) -> dict:
    raw = regular(report).read_bytes()
    config = read_json(assistant / "data/config.json")
    batches = [read_json(path) for path in sorted((assistant / "data/batches").glob("*.json"))]
    matching = []
    for batch in batches:
        identity = hashlib.sha256(hashlib.sha256(raw).digest() + batch["store"].encode() + batch["market"].encode()).hexdigest()[:24]
        if identity == batch["id"]:
            matching.append(batch)
    if len(matching) != 1 or matching[0]["store"] != store:
        raise ValueError("Report must exactly match one legacy batch and the explicitly selected store")
    batch, rows = matching[0], report_rows(raw)
    if set(batch["items"]) != {row["key"] for row in rows}:
        raise ValueError("Report items differ from the legacy checkpoint")
    for row in rows:
        saved = batch["items"][row["key"]]
        row["archivePath"] = saved.get("archive", "")
        row["overrides"] = saved.get("overrides", {})
        row["trackingPresent"] = bool(saved.get("tracking"))
        try:
            checksum, size, marketplace = check_archive(Path(row["archivePath"]), row["orderNumber"], row["itemNumber"])
            row.update(archiveSha256=checksum, archiveBytes=size, marketplaceId=marketplace, archiveReady=True)
        except (ValueError, OSError, zipfile.BadZipFile, UnicodeError):
            row.update(archiveReady=False, diagnostic="原始 ZIP 缺失、超限或身份/完整性检查未通过")
    keys = {row["key"] for row in rows}
    corrections = assistant / "data/address-corrections.json"
    address_changes = read_json(corrections) if corrections.exists() else {}
    markets = {}
    order_markets = {}
    for row in rows:
        if not row["archiveReady"]:
            continue
        site = row["marketplaceId"]
        if row["orderNumber"] in order_markets and order_markets[row["orderNumber"]] != site:
            raise ValueError("One order has conflicting original marketplace identities")
        order_markets[row["orderNumber"]] = site
        markets.setdefault(site, []).append(row)
    return {
        "format": "yummyai-order-assistant-intake-preview-v1", "store": store, "legacyBatch": batch["id"],
        "reportPath": str(report.absolute()), "reportSha256": sha(raw), "marketHint": batch["market"],
        "orders": len({row["orderNumber"] for row in rows}), "items": len(rows), "quantity": sum(row["quantity"] for row in rows),
        "archiveReady": sum(row["archiveReady"] for row in rows), "rows": rows,
        "marketplaces": {site: {"items": len(items), "orders": len({row["orderNumber"] for row in items}), "quantity": sum(row["quantity"] for row in items)} for site, items in sorted(markets.items())},
        "olderOnlyItems": sorted(set().union(*(set(other["items"]) for other in batches)) - keys),
        "parcelAdjustments": batch.get("shipments", {}),
        "addressCorrectionOrders": [key.split("|", 1)[-1] for key, value in address_changes.items() if key.startswith(store + "|") and value.get("values")],
        "catalogReference": {"products": config["products"], "skus": config["skus"]},
        "boundaries": ["当前店铺仍由个人登录会话选择 原始报告重复订单由 ERP 原拥有者去重", "店铺站点按原报告来源核对 收件国家不等于销售站点", "产品规格由原始 ZIP 定制信息与 ERP 现有产品档案匹配", "包裹调整需运营核对后在物流单据预检录入", "较早批次独有项保持待核对 不自动推定已发货或取消", "此清单不是病毒扫描、审单批准、生产批准或发货证明"],
    }


def write_kit(result: dict, output: Path):
    output = output.absolute()
    repo = Path(__file__).resolve().parents[2]
    if output == repo or repo in output.parents or output.exists():
        raise ValueError("Use a new output directory outside the source tree")
    for parent in output.parents:
        if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
            raise ValueError("Linked output parents are not accepted")
    output.mkdir(parents=True, exist_ok=False)
    (output / "original").mkdir()
    for site in result["marketplaces"]:
        (output / site / "archives").mkdir(parents=True)
    for source, destination, checksum in [(Path(result["reportPath"]), output / "original" / Path(result["reportPath"]).name, result["reportSha256"]), *[(Path(row["archivePath"]), output / row["marketplaceId"] / "archives" / f'{row["key"]}.zip', row["archiveSha256"]) for row in result["rows"] if row["archiveReady"]]]:
        shutil.copyfile(regular(source), destination)
        if sha(destination.read_bytes()) != checksum or sha(source.read_bytes()) != checksum:
            raise ValueError("Source changed during intake-kit preparation; do not import this kit")
    source_bytes = (output / "original" / Path(result["reportPath"]).name).read_bytes()
    try:
        decoded = source_bytes.decode("utf-8-sig")
    except UnicodeError:
        decoded = source_bytes.decode("gb18030")
    reader = csv.DictReader(io.StringIO(decoded, newline=""), delimiter="\t", strict=True)
    source_rows = list(reader)
    row_market = {row["key"]: row.get("marketplaceId") for row in result["rows"]}
    result["derivedReports"] = []
    for site in result["marketplaces"]:
        buffer = io.StringIO(newline="")
        writer = csv.DictWriter(buffer, fieldnames=reader.fieldnames, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(row for row in source_rows if row_market.get(row["order-id"] + "_" + row["order-item-id"]) == site)
        content = buffer.getvalue().encode("utf-8")
        relative = f"{site}/orders-{site}.txt"
        (output / relative).write_bytes(content)
        result["derivedReports"].append({"path": relative, "sha256": sha(content), "sourceSha256": result["reportSha256"], "marketplaceId": site, "basis": "original ZIP marketplaceId; all report cell values preserved"})
    (output / "migration-preview.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "迁入说明.md").write_text(f"# 订单助手迁入核对\n\n目标店铺：{result['store']}\n\n{result['orders']} 单 / {result['items']} 个订单项 / {result['quantity']} 件，原始 ZIP 可承接 {result['archiveReady']} 个。\n\n1. 个人账号登录 ERP，在订单报告导入页选择对应店铺。\n2. ATVPDKIKX0DER 为美国，A2EUQ1WTGCTBG2 为加拿大。按原始 ZIP 的 marketplaceId 分别导入各目录内的 TXT，核对新增、重复、异常回执。original 目录仅用于原始报告追溯，不直接导入混合站点报告。\n3. 展开批量承接已下载的原始 ZIP，选择对应站点 archives 中的文件，先检查匹配结果再开始。\n4. 已有可读取内容的订单项自动跳过；中断后可重复选择，服务端继续检查原始 ZIP 身份与文件安全。\n5. migration-preview.json 保存原始文件哈希、拆分报告来源、产品映射参考、包裹调整和较早批次独有项。包裹调整与旧资料不是审单或生产批准。\n\n此文件夹含买家原始资料，请按原订单资料保留期限管理，完成迁入后由运营确认处理。\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assistant", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--store", required=True)
    parser.add_argument("--output", type=Path, help="Copy an intake kit to this new directory; omitted means read-only preview")
    args = parser.parse_args()
    result = preview(args.assistant, args.report, args.store)
    if args.output:
        write_kit(result, args.output)
    print(json.dumps({key: result[key] for key in ["format", "store", "orders", "items", "quantity", "archiveReady"]}, ensure_ascii=False))
    print(json.dumps({"marketplaces": result["marketplaces"], "olderOnlyItems": len(result["olderOnlyItems"]), "parcelAdjustmentOrders": len(result["parcelAdjustments"]), "addressCorrectionOrders": len(result["addressCorrectionOrders"]), "outputCreated": bool(args.output)}, ensure_ascii=False))
