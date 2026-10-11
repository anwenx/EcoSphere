-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'DRIVER');

-- CreateEnum
CREATE TYPE "BinStatus" AS ENUM ('NORMAL', 'NEEDS_COLLECTION', 'OVERFLOWING', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'ON_ROUTE', 'MAINTENANCE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "CollectionOutcome" AS ENUM ('COLLECTED', 'PARTIAL', 'INACCESSIBLE', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "SolverStatus" AS ENUM ('OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'TIMED_OUT_FEASIBLE', 'FAILED');

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('OSRM_ROAD', 'STRAIGHT_LINE_APPROX');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('CRITICAL_FILL', 'OVERFLOW', 'FAILED_COLLECTION', 'DELAYED_ROUTE', 'VEHICLE_BREAKDOWN', 'UNASSIGNED_CRITICAL_BIN', 'OPTIMIZATION_FAILURE', 'STALE_VEHICLE_POSITION');

-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('BLOCKED_ROAD', 'INACCESSIBLE_BIN', 'VEHICLE_ISSUE');

-- CreateEnum
CREATE TYPE "DataOrigin" AS ENUM ('REAL', 'DEMO', 'SIMULATED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "boundary" geography(Polygon,4326),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "origin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Depot" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" geography(Point,4326) NOT NULL,
    "opensAt" TEXT NOT NULL DEFAULT '06:00',
    "closesAt" TEXT NOT NULL DEFAULT '20:00',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "origin" "DataOrigin" NOT NULL DEFAULT 'REAL',

    CONSTRAINT "Depot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bin" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "location" geography(Point,4326) NOT NULL,
    "fillPercent" INTEGER NOT NULL DEFAULT 0,
    "capacityLiters" INTEGER NOT NULL,
    "status" "BinStatus" NOT NULL DEFAULT 'NORMAL',
    "zoneId" TEXT NOT NULL,
    "origin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "lastCollectedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "capacityLiters" INTEGER NOT NULL,
    "maxStops" INTEGER,
    "location" geography(Point,4326),
    "locationAt" TIMESTAMP(3),
    "locationOrigin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "maintenanceNote" TEXT,
    "fuelKmPerLiter" DECIMAL(6,2),
    "driverId" TEXT,
    "origin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecord" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "plannedDate" DATE NOT NULL,
    "status" "RouteStatus" NOT NULL DEFAULT 'DRAFT',
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "depotId" TEXT NOT NULL,
    "jobId" TEXT,
    "totalDistanceM" INTEGER,
    "drivingSeconds" INTEGER,
    "serviceSeconds" INTEGER,
    "baselineDistanceM" INTEGER,
    "costSource" "CostSource",
    "origin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteStop" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "binId" TEXT NOT NULL,
    "stopOrder" INTEGER NOT NULL,
    "status" "StopStatus" NOT NULL DEFAULT 'PENDING',
    "estimatedArrival" TIMESTAMP(3),
    "serviceSeconds" INTEGER NOT NULL DEFAULT 180,
    "expectedLiters" INTEGER,
    "actualArrival" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),

    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionRecord" (
    "id" TEXT NOT NULL,
    "binId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "routeStopId" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "fillBefore" INTEGER NOT NULL,
    "fillAfter" INTEGER,
    "quantityLiters" INTEGER,
    "outcome" "CollectionOutcome" NOT NULL,
    "notes" TEXT,
    "imageRef" TEXT,
    "origin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationJob" (
    "id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedById" TEXT NOT NULL,
    "plannedDate" DATE NOT NULL,
    "params" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OptimizationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "solverStatus" "SolverStatus" NOT NULL,
    "costSource" "CostSource" NOT NULL,
    "objectiveValue" BIGINT,
    "optimizedDistanceM" INTEGER,
    "baselineDistanceM" INTEGER,
    "distanceReductionPercent" DECIMAL(6,2),
    "routesJson" JSONB NOT NULL,
    "unassignedJson" JSONB NOT NULL,
    "violationsJson" JSONB NOT NULL,
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "origin" "DataOrigin" NOT NULL DEFAULT 'REAL',
    "assignedToId" TEXT,
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverIssue" (
    "id" TEXT NOT NULL,
    "type" "IssueType" NOT NULL,
    "driverId" TEXT NOT NULL,
    "routeId" TEXT,
    "binId" TEXT,
    "vehicleId" TEXT,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SimulationState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "step" INTEGER NOT NULL DEFAULT 0,
    "tickMs" INTEGER NOT NULL DEFAULT 5000,
    "lockedBy" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimulationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_code_key" ON "Zone"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Bin_code_key" ON "Bin"("code");

-- CreateIndex
CREATE INDEX "Bin_status_idx" ON "Bin"("status");

-- CreateIndex
CREATE INDEX "Bin_zoneId_status_idx" ON "Bin"("zoneId", "status");

-- CreateIndex
CREATE INDEX "Bin_fillPercent_idx" ON "Bin"("fillPercent");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_code_key" ON "Vehicle"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_driverId_key" ON "Vehicle"("driverId");

-- CreateIndex
CREATE INDEX "Vehicle_status_idx" ON "Vehicle"("status");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_vehicleId_reportedAt_idx" ON "MaintenanceRecord"("vehicleId", "reportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Route_code_key" ON "Route"("code");

-- CreateIndex
CREATE INDEX "Route_plannedDate_status_idx" ON "Route"("plannedDate", "status");

-- CreateIndex
CREATE INDEX "Route_vehicleId_plannedDate_idx" ON "Route"("vehicleId", "plannedDate");

-- CreateIndex
CREATE INDEX "Route_driverId_plannedDate_idx" ON "Route"("driverId", "plannedDate");

-- CreateIndex
CREATE INDEX "RouteStop_binId_idx" ON "RouteStop"("binId");

-- CreateIndex
CREATE INDEX "RouteStop_status_idx" ON "RouteStop"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RouteStop_routeId_stopOrder_key" ON "RouteStop"("routeId", "stopOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RouteStop_routeId_binId_key" ON "RouteStop"("routeId", "binId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRecord_routeStopId_key" ON "CollectionRecord"("routeStopId");

-- CreateIndex
CREATE INDEX "CollectionRecord_binId_collectedAt_idx" ON "CollectionRecord"("binId", "collectedAt");

-- CreateIndex
CREATE INDEX "CollectionRecord_collectedAt_idx" ON "CollectionRecord"("collectedAt");

-- CreateIndex
CREATE INDEX "CollectionRecord_vehicleId_collectedAt_idx" ON "CollectionRecord"("vehicleId", "collectedAt");

-- CreateIndex
CREATE INDEX "OptimizationJob_status_createdAt_idx" ON "OptimizationJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationResult_jobId_key" ON "OptimizationResult"("jobId");

-- CreateIndex
CREATE INDEX "Alert_status_severity_createdAt_idx" ON "Alert"("status", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_entityType_entityId_idx" ON "Alert"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "DriverIssue_type_createdAt_idx" ON "DriverIssue"("type", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Bin" ADD CONSTRAINT "Bin_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OptimizationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_binId_fkey" FOREIGN KEY ("binId") REFERENCES "Bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRecord" ADD CONSTRAINT "CollectionRecord_binId_fkey" FOREIGN KEY ("binId") REFERENCES "Bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRecord" ADD CONSTRAINT "CollectionRecord_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRecord" ADD CONSTRAINT "CollectionRecord_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRecord" ADD CONSTRAINT "CollectionRecord_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "RouteStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationResult" ADD CONSTRAINT "OptimizationResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OptimizationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverIssue" ADD CONSTRAINT "DriverIssue_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
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
