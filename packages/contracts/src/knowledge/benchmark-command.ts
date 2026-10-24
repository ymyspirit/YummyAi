import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
export const BENCHMARK_OPERATIONS=["dataset.create","dataset.save","dataset.publish","experiment.create","attempt.start","attempt.review","expense.record","report.create"] as const;
export type BenchmarkOperation=typeof BENCHMARK_OPERATIONS[number];
/** Hash UTF-8 bytes with SHA-256 on both server and browser, after parsing the shared input schema. */
export const benchmarkCommandCanonical=(operation:BenchmarkOperation,parentId:string|null,input:unknown)=>canonicalJson({version:1,operation,parentId,input});
