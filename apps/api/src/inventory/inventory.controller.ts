import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { Permission, authorize } from "@yummyai/authz";
import {
  CancelInventoryTransferInputSchema,
  CreateInventoryLocationInputSchema,
  CreateInventoryLotInputSchema,
  CreateInventoryReservationInputSchema,
  CreateInventoryTransferInputSchema,
  CreateStockItemInputSchema,
  CreateWarehouseInputSchema,
  DispatchInventoryTransferInputSchema,
  RebuildInventoryProjectionInputSchema,
  ReceiveInventoryTransferInputSchema,
  RecordInventoryMovementInputSchema,
  ReleaseInventoryReservationInputSchema,
} from "@yummyai/contracts";
import { z } from "zod";
import { UpdateWarehouseInputSchema, UpdateInventoryLocationInputSchema, UpdateStockItemInputSchema,
  ClassifyInventoryStockItemInputSchema, InventoryStockItemViewSchema } from "@yummyai/contracts/inventory";

import { RequiresPermission } from "../auth/permissions.decorator.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";
import { InventoryService } from "./inventory.service.js";

@Controller("v1/inventory")
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly service: InventoryService) {}

  @Get("workspace")
  @RequiresPermission(Permission.InventoryRead)
  workspace(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.workspace(context);
  }

  @Get("warehouses")
  @RequiresPermission(Permission.InventoryRead)
  warehouses(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listWarehouses(context);
  }

  @Post("warehouses")
  @RequiresPermission(Permission.InventoryWrite)
  createWarehouse(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.createWarehouse(context, CreateWarehouseInputSchema.parse(body));
  }

  @Get("locations")
  @RequiresPermission(Permission.InventoryRead)
  locations(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listLocations(context);
  }

  @Post("locations")
  @RequiresPermission(Permission.InventoryWrite)
  createLocation(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.createLocation(context, CreateInventoryLocationInputSchema.parse(body));
  }

  @Get("stock-items")
  @RequiresPermission(Permission.InventoryRead)
  stockItems(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listStockItems(context);
  }

  @Post("stock-items")
  @RequiresPermission(Permission.InventoryWrite)
  async createStockItem(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return InventoryStockItemViewSchema.parse(await this.service.createStockItem(context, CreateStockItemInputSchema.parse(body)));
  }

  @Post("stock-items/:id/classifications")
  @RequiresPermission(Permission.InventoryWrite)
  classifyStockItem(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.InventoryWrite);
    return this.service.classifyStockItem(context, z.uuidv7().parse(id), ClassifyInventoryStockItemInputSchema.parse(body));
  }

  @Get("stock-items/:id/classifications")
  @RequiresPermission(Permission.InventoryRead)
  classificationHistory(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query("beforeVersion") beforeVersion?: string) {
    const context = requireContext(request); authorize(context, Permission.InventoryRead);
    return this.service.stockClassificationHistory(context, z.uuidv7().parse(id), z.coerce.number().int().positive().optional().parse(beforeVersion));
  }

  @Get("lots")
  @RequiresPermission(Permission.InventoryRead)
  lots(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listLots(context);
  }

  @Patch("warehouses/:id")
  @RequiresPermission(Permission.InventoryWrite)
  updateWarehouse(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.InventoryWrite);
    return this.service.updateWarehouse(context, z.uuidv7().parse(id), UpdateWarehouseInputSchema.parse(body));
  }

  @Patch("locations/:id")
  @RequiresPermission(Permission.InventoryWrite)
  updateLocation(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.InventoryWrite);
    return this.service.updateLocation(context, z.uuidv7().parse(id), UpdateInventoryLocationInputSchema.parse(body));
  }

  @Patch("stock-items/:id")
  @RequiresPermission(Permission.InventoryWrite)
  updateStockItem(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const context = requireContext(request); authorize(context, Permission.InventoryWrite);
    return this.service.updateStockItem(context, z.uuidv7().parse(id), UpdateStockItemInputSchema.parse(body));
  }

  @Post("lots")
  @RequiresPermission(Permission.InventoryWrite)
  createLot(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.createLot(context, CreateInventoryLotInputSchema.parse(body));
  }

  @Get("movements")
  @RequiresPermission(Permission.InventoryRead)
  movements(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listMovements(context);
  }

  @Post("movements")
  @RequiresPermission(Permission.InventoryWrite)
  recordMovement(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.recordMovement(context, RecordInventoryMovementInputSchema.parse(body));
  }

  @Get("balances")
  @RequiresPermission(Permission.InventoryRead)
  balances(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listBalances(context);
  }

  @Get("reservations")
  @RequiresPermission(Permission.InventoryRead)
  reservations(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listReservations(context);
  }

  @Get("reservations/:reservationId")
  @RequiresPermission(Permission.InventoryRead)
  reservation(@Req() request: AuthenticatedRequest, @Param("reservationId") reservationId: string) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.getReservation(context, z.uuidv7().parse(reservationId));
  }

  @Post("reservations")
  @RequiresPermission(Permission.InventoryWrite)
  createReservation(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.createReservation(context, CreateInventoryReservationInputSchema.parse(body));
  }

  @Post("reservations/:reservationId/release")
  @RequiresPermission(Permission.InventoryWrite)
  releaseReservation(
    @Req() request: AuthenticatedRequest,
    @Param("reservationId") reservationId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.releaseReservation(
      context,
      z.uuidv7().parse(reservationId),
      ReleaseInventoryReservationInputSchema.parse(body),
    );
  }

  @Get("transfers")
  @RequiresPermission(Permission.InventoryRead)
  transfers(@Req() request: AuthenticatedRequest) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.listTransfers(context);
  }

  @Get("transfers/:transferId")
  @RequiresPermission(Permission.InventoryRead)
  transfer(@Req() request: AuthenticatedRequest, @Param("transferId") transferId: string) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryRead);
    return this.service.getTransfer(context, z.uuidv7().parse(transferId));
  }

  @Post("transfers")
  @RequiresPermission(Permission.InventoryWrite)
  createTransfer(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.createTransfer(context, CreateInventoryTransferInputSchema.parse(body));
  }

  @Post("transfers/:transferId/dispatch")
  @RequiresPermission(Permission.InventoryWrite)
  dispatchTransfer(
    @Req() request: AuthenticatedRequest,
    @Param("transferId") transferId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.dispatchTransfer(
      context,
      z.uuidv7().parse(transferId),
      DispatchInventoryTransferInputSchema.parse(body),
    );
  }

  @Post("transfers/:transferId/receive")
  @RequiresPermission(Permission.InventoryWrite)
  receiveTransfer(
    @Req() request: AuthenticatedRequest,
    @Param("transferId") transferId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.receiveTransfer(
      context,
      z.uuidv7().parse(transferId),
      ReceiveInventoryTransferInputSchema.parse(body),
    );
  }

  @Post("transfers/:transferId/cancel")
  @RequiresPermission(Permission.InventoryWrite)
  cancelTransfer(
    @Req() request: AuthenticatedRequest,
    @Param("transferId") transferId: string,
    @Body() body: unknown,
  ) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.cancelTransfer(
      context,
      z.uuidv7().parse(transferId),
      CancelInventoryTransferInputSchema.parse(body),
    );
  }

  @Post("projections/rebuild")
  @RequiresPermission(Permission.InventoryWrite)
  rebuildProjection(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const context = requireContext(request);
    authorize(context, Permission.InventoryWrite);
    return this.service.rebuildProjection(context, RebuildInventoryProjectionInputSchema.parse(body));
  }
}

function requireContext(request: AuthenticatedRequest) {
  if (!request.tenantContext) throw new Error("Tenant context is required");
  return request.tenantContext;
}
