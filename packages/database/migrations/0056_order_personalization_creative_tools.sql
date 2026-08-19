ALTER TABLE "order_personalization_render_tasks" DROP CONSTRAINT "order_personalization_render_tasks_tool_check";
--> statement-breakpoint
ALTER TABLE "order_personalization_render_tasks" ADD CONSTRAINT "order_personalization_render_tasks_tool_check" CHECK ("tool_key" in ('image_composite','group_photo','pet_outfit','fulfillment_composite'));
