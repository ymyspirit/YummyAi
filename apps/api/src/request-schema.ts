import { BadRequestException } from "@nestjs/common";
import type { ZodType } from "zod";

/** HTTP input only. Output/transaction failures must keep their uncertain server-error semantics. */
export function parseRequestSchema<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException("输入内容格式有误 请核对必填字段和版本编号");
  return result.data;
}
