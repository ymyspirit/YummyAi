import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { SalesRecipeActionSchema } from "@yummyai/contracts/catalog/development";
import { salesRecipeVersions, type DatabaseConnection } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { SalesAdaptationService } from "../design/sales-adaptation.service.js";
import {
  lockDevelopment,
  mutateDevelopment,
  readRecipe,
  assertActiveCatalogSource,
} from "./development-data.js";

@Injectable()
export class SalesRecipeService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(SalesAdaptationService) private readonly adaptation: SalesAdaptationService,
  ) {}
  async action(context: TenantContext, recipeId: string, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = SalesRecipeActionSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "recipe",
          id: recipeId,
          permissions: [Permission.ProductWrite],
          additional: [
            { kind: "recipeArtwork", id: recipeId, permissions: [Permission.DesignRead] },
          ],
        },
        key: input.idempotencyKey,
        action: `recipe.${input.action}`,
        resourceId: recipeId,
        reason: input.reason,
        input: { recipeId, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        await lockDevelopment(tx, context, `recipe:${recipeId}`);
        const recipe = await readRecipe(tx, recipeId);
        await assertActiveCatalogSource(tx, recipe.specification.spuId, recipe.skuId);
        if (recipe.status === "approved" || recipe.status === "ready_for_customization")
          throw new ConflictException("已审核制作记录不可覆盖，请创建新版本");
        if (input.action === "confirm_customization_plan") {
          await this.adaptation.validateCustomizationPlan(context, recipe);
          await tx
            .update(salesRecipeVersions)
            .set({ status: "ready_for_customization", updatedAt: new Date() })
            .where(eq(salesRecipeVersions.id, recipeId));
        } else if (input.action === "start_adaptation") {
          const editor = await this.adaptation.start(context, recipe, tx);
          await tx
            .update(salesRecipeVersions)
            .set({
              status: "in_adaptation",
              editorProjectId: editor.project.id,
              updatedAt: new Date(),
            })
            .where(eq(salesRecipeVersions.id, recipeId));
        } else if (input.action === "approve_adaptation") {
          if (!specificationFactsReady(recipe.specification.facts))
            throw new ConflictException("请先核实产品材质、尺寸和包装事实，再升级制作版本");
          if (!input.expectedEditorVersionId || !input.renderId)
            throw new ConflictException("请选择审核的编辑版本和生产出图");
          const result = await this.adaptation.approve(
            tx,
            context,
            recipe,
            input.expectedEditorVersionId,
            input.renderId,
            input.reason,
          );
          await tx
            .update(salesRecipeVersions)
            .set({
              status: "approved",
              editorVersionId: input.expectedEditorVersionId,
              renderId: input.renderId,
              designVersionId: result.designVersionId,
              updatedAt: new Date(),
            })
            .where(eq(salesRecipeVersions.id, recipeId));
        } else throw new ConflictException("未审核项目可直接继续编辑；已审核版本请使用创建新版本");
        return { recipe: await readRecipe(tx, recipeId) };
      },
    );
  }
}
