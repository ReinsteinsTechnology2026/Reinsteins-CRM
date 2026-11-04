// The platform-database DDL for tenant feature selection. Used by _migrate_add_company_features.js and copied verbatim
// into schemas/platformSchema.postgresql.sql (_test_tenant_features.js fails if the two ever differ), so a brand-new
// platform database and a migrated one end up identical.
//
// One row per (company, feature): `enabled` is the Owner's decision. It lives in the PLATFORM database, never in a tenant
// database, so a tenant (including its admins) can neither read another company's configuration nor change its own.
// Disabling a feature only flips this flag -- no tenant data is touched, so enabling it again restores everything.

const COMPANY_FEATURES_DDL = `-- ---------- Tenant feature selection: which CRM modules each company may use. One row per (company, feature);
-- feature_id is a stable identifier from config/tenantFeatures.js. A company with NO rows has never been configured and
-- is treated as having every module (so a company created before this table existed keeps working). ----------
CREATE TABLE IF NOT EXISTS "company_features" (
  "company_id" integer NOT NULL,
  "feature_id" varchar(64) NOT NULL,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "updated_by" integer DEFAULT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("company_id", "feature_id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_company_features_company_id') THEN
    ALTER TABLE "company_features"
      ADD CONSTRAINT "fk_company_features_company_id"
      FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
      ON DELETE CASCADE;
  END IF;
END $$;
`;

module.exports = { COMPANY_FEATURES_DDL };
