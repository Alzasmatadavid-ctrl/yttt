ALTER TABLE "businesses" ADD COLUMN "account_business_id" uuid;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_account_business_id_businesses_id_fk" FOREIGN KEY ("account_business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Negocios adicionales ya creados (POST /api/businesses deja «business.created» con fromBusinessId en la auditoría):
-- se enlazan con el negocio principal de su cuenta, siguiendo la cadena si se crearon unos desde otros.
WITH RECURSIVE "created" AS (
  SELECT DISTINCT ON ("entity_id") "entity_id"::uuid AS "id", ("metadata"->>'fromBusinessId')::uuid AS "parent"
  FROM "audit_logs"
  WHERE "action" = 'business.created' AND "entity_type" = 'business'
    AND "entity_id" ~ '^[0-9a-fA-F-]{36}$' AND "metadata"->>'fromBusinessId' ~ '^[0-9a-fA-F-]{36}$'
  ORDER BY "entity_id", "created_at"
), "chain" AS (
  SELECT "id", "parent" AS "root", 1 AS "depth" FROM "created"
  UNION ALL
  SELECT "chain"."id", "created"."parent", "chain"."depth" + 1
  FROM "chain" JOIN "created" ON "created"."id" = "chain"."root"
  WHERE "chain"."depth" < 50
)
UPDATE "businesses" SET "account_business_id" = "chain"."root"
FROM "chain"
WHERE "businesses"."id" = "chain"."id"
  AND "businesses"."account_business_id" IS NULL
  AND "chain"."root" <> "chain"."id"
  AND NOT EXISTS (SELECT 1 FROM "created" WHERE "created"."id" = "chain"."root")
  AND EXISTS (SELECT 1 FROM "businesses" AS "root_business" WHERE "root_business"."id" = "chain"."root");
