-- Append to the first Prisma migration (prisma migrate dev --create-only), then apply.
-- NOT yet executed against a database.
CREATE INDEX bin_location_gix     ON "Bin"     USING GIST (location);
CREATE INDEX zone_boundary_gix    ON "Zone"    USING GIST (boundary);
CREATE INDEX vehicle_location_gix ON "Vehicle" USING GIST (location);
CREATE INDEX depot_location_gix   ON "Depot"   USING GIST (location);

ALTER TABLE "Bin" ADD CONSTRAINT bin_fill_range CHECK ("fillPercent" BETWEEN 0 AND 100);
ALTER TABLE "Bin" ADD CONSTRAINT bin_capacity_positive CHECK ("capacityLiters" > 0);
ALTER TABLE "Vehicle" ADD CONSTRAINT vehicle_capacity_positive CHECK ("capacityLiters" > 0);
ALTER TABLE "CollectionRecord" ADD CONSTRAINT coll_fill_before CHECK ("fillBefore" BETWEEN 0 AND 100);
ALTER TABLE "CollectionRecord" ADD CONSTRAINT coll_qty_nonneg CHECK ("quantityLiters" IS NULL OR "quantityLiters" >= 0);

-- One non-terminal route per vehicle / driver per planned date
CREATE UNIQUE INDEX route_active_vehicle_uq ON "Route" ("vehicleId", "plannedDate")
  WHERE status IN ('PUBLISHED','IN_PROGRESS');
CREATE UNIQUE INDEX route_active_driver_uq ON "Route" ("driverId", "plannedDate")
  WHERE "driverId" IS NOT NULL AND status IN ('PUBLISHED','IN_PROGRESS');

-- Audit log append-only at the DB level
CREATE OR REPLACE FUNCTION audit_no_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'AuditLog is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_no_mutation();
