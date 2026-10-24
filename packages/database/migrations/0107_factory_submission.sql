ALTER TABLE production_delivery_feedback DROP CONSTRAINT production_delivery_feedback_kind_check;
ALTER TABLE production_delivery_feedback ADD CONSTRAINT production_delivery_feedback_kind_check CHECK(kind IN ('submitted','received','accepted','rejected','rework'));
