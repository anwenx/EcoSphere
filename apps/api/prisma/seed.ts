/**

 * Deterministic DEMO seed. Same SEED_VALUE + same DEMO_CENTER => identical ids, codes and coordinates.

 * Everything inserted here is tagged origin=DEMO. Local development only.

 *

 * Optional env: SEED_VALUE (default 42), DEMO_CENTER_LAT / DEMO_CENTER_LNG (default 12.9716 / 77.5946),

 *               DEMO_PASSWORD (if unset, a random one is generated and printed once).

 */

import 'dotenv/config';

import { createHash, randomBytes } from 'node:crypto';

import { PrismaClient, type BinStatus } from '@prisma/client';

import { hash } from 'argon2';

import { reconcileBinAlerts } from '../src/modules/alerts/alerts.service';



const prisma = new PrismaClient();



const SEED = Number(process.env.SEED_VALUE ?? 42);

const CENTER = {

  lat: Number(process.env.DEMO_CENTER_LAT ?? 12.9716),

  lng: Number(process.env.DEMO_CENTER_LNG ?? 77.5946),

};

const HALF_SPAN = 0.045; // degrees (\~5 km) each side of the center

const BIN_COUNT = 120;



// Default collection thresholds; also stored in Setting so they become configurable later.

const THRESHOLDS = { needsCollectionPercent: 70, overflowingPercent: 95, criticalPercent: 81 };



function mulberry32(a: number) {

  return () => {

    a |= 0;

    a = (a + 0x6d2b79f5) | 0;

    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;

  };

}

const rand = mulberry32(SEED);

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;



/** Stable UUID derived from the seed and a name, so re-seeding yields the same ids. */

function detId(name: string): string {

  const h = createHash('sha1').update(`${SEED}:${name}`).digest('hex');

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;

}



function statusFor(fill: number): BinStatus {

  if (fill >= THRESHOLDS.overflowingPercent) return 'OVERFLOWING';

  if (fill >= THRESHOLDS.needsCollectionPercent) return 'NEEDS_COLLECTION';

  return 'NORMAL';

}



const ZONES = [

  { code: 'NE', name: 'North-East', sx: 1, sy: 1 },

  { code: 'NW', name: 'North-West', sx: -1, sy: 1 },

  { code: 'SE', name: 'South-East', sx: 1, sy: -1 },

  { code: 'SW', name: 'South-West', sx: -1, sy: -1 },

] as const;



const DRIVERS = ['Rahul Verma', 'Priya Nair', 'Imran Sheikh', 'Anita Das', 'Suresh Patel', 'Meena Rao'] as const;



async function main() {

  if (process.env.NODE_ENV === 'production') {

    throw new Error('Refusing to run the demo seed with NODE_ENV=production.');

  }



  const generated = !process.env.DEMO_PASSWORD;

  const password = process.env.DEMO_PASSWORD ?? randomBytes(9).toString('base64url');

  const passwordHash = await hash(password);



  // --- Clean previous demo data safely (children before parents) ---
  await prisma.alert.deleteMany({ where: { origin: 'DEMO' } });
  await prisma.collectionRecord.deleteMany({ where: { origin: 'DEMO' } });

  // Some demo-generated routes were incorrectly marked REAL while referencing
  // demo-owned vehicles, depots, or bins. Remove only those contaminated routes
  // before cleaning their dependencies. Unrelated REAL routes are preserved.
  await prisma.route.deleteMany({
    where: {
      OR: [
        { origin: 'DEMO' },
        { vehicle: { origin: 'DEMO' } },
        { depot: { origin: 'DEMO' } },
        { stops: { some: { bin: { origin: 'DEMO' } } } },
      ],
    },
  });

  // RouteStop has onDelete: Cascade from Route, so stops for deleted routes
  // are removed automatically. Clear any leftover stops on demo routes too.
  await prisma.routeStop.deleteMany({
    where: { route: { origin: 'DEMO' } },
  });

  // Remove dependent demo records before their parent zones/vehicles/depots.
  await prisma.bin.deleteMany({ where: { origin: 'DEMO' } });
  await prisma.zone.deleteMany({ where: { origin: 'DEMO' } });
  await prisma.vehicle.deleteMany({ where: { origin: 'DEMO' } });
  await prisma.depot.deleteMany({ where: { origin: 'DEMO' } });


  // --- Users (upsert by email; password refreshed on every seed) ---

  const staff = [

    { email: 'admin@ecosphere.demo', name: 'Demo Admin', role: 'ADMIN' as const },

    { email: 'manager@ecosphere.demo', name: 'Demo Operations Manager', role: 'MANAGER' as const },

  ];

  for (const u of staff) {

    await prisma.user.upsert({

      where: { email: u.email },

      update: { name: u.name, role: u.role, passwordHash, isActive: true },

      create: { id: detId(`user:${u.email}`), ...u, passwordHash },

    });

  }

  const driverIds: string[] = [];

  for (const [i, name] of DRIVERS.entries()) {

    const email = `driver${i + 1}@ecosphere.demo`;

    const user = await prisma.user.upsert({

      where: { email },

      update: { name, role: 'DRIVER', passwordHash, isActive: true },

      create: { id: detId(`user:${email}`), email, name, role: 'DRIVER', passwordHash },

    });

    driverIds.push(user.id);

  }



  // --- Zones (quadrants around the center) ---

  const zoneIdByCode = new Map<string, string>();

  for (const z of ZONES) {

    const id = detId(`zone:${z.code}`);

    zoneIdByCode.set(z.code, id);

    const x0 = CENTER.lng;

    const y0 = CENTER.lat;

    const x1 = CENTER.lng + z.sx * HALF_SPAN;

    const y1 = CENTER.lat + z.sy * HALF_SPAN;

    const wkt = `POLYGON((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))`;

    await prisma.$executeRaw`

      INSERT INTO "Zone" (id, name, code, description, boundary, "isActive", origin)

      VALUES (${id}, ${z.name}, ${z.code}, ${'Demo zone (generated)'}, ST_GeogFromText(${wkt}), true, 'DEMO'::"DataOrigin")`;

  }



  // --- Depot ---

  const depotId = detId('depot:main');

  const depotLng = CENTER.lng + 0.004;

  const depotLat = CENTER.lat - 0.003;

  await prisma.$executeRaw`

    INSERT INTO "Depot" (id, name, location, "opensAt", "closesAt", "isActive", origin)

    VALUES (${depotId}, ${'Central Depot (demo)'}, ST_SetSRID(ST_MakePoint(${depotLng}::float8, ${depotLat}::float8), 4326)::geography,

            ${'06:00'}, ${'20:00'}, true, 'DEMO'::"DataOrigin")`;



  // --- Bins ---

  const BIN_TYPES = ['GENERAL', 'GENERAL', 'GENERAL', 'RECYCLING', 'RECYCLING', 'ORGANIC'] as const;

  const CAPACITIES = [240, 660, 1100] as const;

  const now = Date.now();

  for (let i = 1; i <= BIN_COUNT; i++) {

    const lng = CENTER.lng + (rand() * 2 - 1) * HALF_SPAN;

    const lat = CENTER.lat + (rand() * 2 - 1) * HALF_SPAN;

    const zone = ZONES.find((z) => Math.sign(lng - CENTER.lng) === z.sx && Math.sign(lat - CENTER.lat) === z.sy);

    const zoneId = zoneIdByCode.get(zone ? zone.code : 'NE') as string;

    const fill = Math.min(100, Math.floor(Math.pow(rand(), 1.4) * 101));

    const outOfService = i % 60 === 0;

    const status: BinStatus = outOfService ? 'OUT_OF_SERVICE' : statusFor(fill);

    const lastCollected = new Date(now - Math.floor(1 + rand() * 6) * 86_400_000);

    const code = `BIN-${String(i).padStart(4, '0')}`;

    await prisma.$executeRaw`

      INSERT INTO "Bin" (id, code, type, location, "fillPercent", "capacityLiters", status, "zoneId", origin, "lastCollectedAt", "updatedAt")

      VALUES (${detId(`bin:${code}`)}, ${code}, ${pick(BIN_TYPES)},

              ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography,

              ${fill}::int, ${pick(CAPACITIES)}::int, ${status}::"BinStatus", ${zoneId}, 'DEMO'::"DataOrigin",

              ${lastCollected}::timestamp, now())`;

  }



  // --- Vehicles (one per driver; positions are seeded demo positions, not live GPS) ---

  const VEHICLE_SPECS = [

    { type: 'Compactor 8 m3', cap: 8000, kmpl: 3.2 },

    { type: 'Compactor 8 m3', cap: 8000, kmpl: 3.2 },

    { type: 'Compactor 6 m3', cap: 6000, kmpl: 3.8 },

    { type: 'Compactor 6 m3', cap: 6000, kmpl: 3.8 },

    { type: 'Mini truck 3.5 m3', cap: 3500, kmpl: 6.0 },

    { type: 'Mini truck 3.5 m3', cap: 3500, kmpl: 6.0 },

  ] as const;

  for (const [i, spec] of VEHICLE_SPECS.entries()) {

    const code = `VEH-${String(i + 1).padStart(2, '0')}`;

    await prisma.$executeRaw`

      INSERT INTO "Vehicle" (id, code, type, "capacityLiters", "maxStops", location, "locationAt", "locationOrigin",

                             status, "fuelKmPerLiter", "driverId", origin, "updatedAt")

      VALUES (${detId(`vehicle:${code}`)}, ${code}, ${spec.type}, ${spec.cap}::int, ${40}::int,

              ST_SetSRID(ST_MakePoint(${depotLng}::float8, ${depotLat}::float8), 4326)::geography, now(), 'DEMO'::"DataOrigin",

              'AVAILABLE'::"VehicleStatus", ${spec.kmpl}::numeric, ${driverIds[i] as string}, 'DEMO'::"DataOrigin", now())`;

  }



  for (const b of await prisma.bin.findMany({ where: { origin: 'DEMO' }, select: { id: true, code: true, fillPercent: true, status: true } })) {

    await reconcileBinAlerts(prisma, b, THRESHOLDS, 'DEMO');

  }



  await prisma.setting.upsert({

    where: { key: 'collection.thresholds' },

    update: { value: THRESHOLDS },

    create: { key: 'collection.thresholds', value: THRESHOLDS },

  });

  await prisma.simulationState.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });



  const [bins, vehicles, zones] = await Promise.all([

    prisma.bin.count(),

    prisma.vehicle.count(),

    prisma.zone.count(),

  ]);

  console.log(`Seeded DEMO data (seed=${SEED}): ${bins} bins, ${vehicles} vehicles, ${zones} zones, 1 depot, ${2 + DRIVERS.length} users.`);

  console.log('Demo logins: admin@ecosphere.demo, manager@ecosphere.demo, driver1..driver6@ecosphere.demo');

  console.log(generated ? `Generated demo password (shown once): ${password}` : 'Password: value of DEMO_PASSWORD');

}



main()

  .catch((e) => {

    console.error(e);

    process.exitCode = 1;

  })

  .finally(() => prisma.$disconnect());