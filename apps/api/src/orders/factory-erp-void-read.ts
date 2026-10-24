import { factoryErpVoidRowsSql as sharedfactoryErpVoidRowsSql, factoryErpVoidProofRowsSql as sharedfactoryErpVoidProofRowsSql, factoryErpVoidSummarySql as sharedfactoryErpVoidSummarySql } from "@yummyai/order-core";
import { rethrowOriginalOwnerError } from "../shared/original-owner-error.js";
import { type SQL } from "drizzle-orm";

/** One statement derives every original void's own latest review. It never
 * collects private cells, never adopts another void's conclusion, and includes
 * all observations rather than only the current page. Alias names are fixed. */
export function factoryErpVoidRowsSql(tenantId: SQL, bindingId: SQL) { try { return sharedfactoryErpVoidRowsSql(tenantId, bindingId); } catch(error) { rethrowOriginalOwnerError(error); } }

/** Bound the selected page before touching its sources. Each distinct source's
 * complete claim array is hashed once inside this statement. Only the small
 * authenticated commitment and its uniquely selected claim leave the database. */
export function factoryErpVoidProofRowsSql(tenantId: SQL, bindingId: SQL, selection: { observationId?: string; cursor?: number; limit: number }) { try { return sharedfactoryErpVoidProofRowsSql(tenantId, bindingId, selection); } catch(error) { rethrowOriginalOwnerError(error); } }

export function factoryErpVoidSummarySql(tenantId: SQL, bindingId: SQL) { try { return sharedfactoryErpVoidSummarySql(tenantId, bindingId); } catch(error) { rethrowOriginalOwnerError(error); } }
