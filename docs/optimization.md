# Optimization

Status: implemented as a standalone service (`services/optimizer`). **Not yet integrated into the Express API** and
not yet executed against real OSRM data. Written without being run; see "Verification" below.

## Model
Capacitated VRP solved with Google OR-Tools, extended with:
- **Capacity** (liters of estimated waste) per vehicle, a **max-stops** limit per vehicle (a separate operational constraint),
  a **max route duration** per vehicle, and optional per-bin **time windows** on the start of service.
- All vehicles start and end at the single depot (per-vehicle start positions are not modeled yet).
- **Optional bins**: every bin may be dropped at a priority-weighted penalty, so infeasible bins are reported, never silently removed.

## Objective
`minimize  sum(arc cost) + sum(penalty[priority] for each unserved bin)`
- `MIN_DISTANCE`: arc cost = road meters. `MIN_DURATION`: arc cost = seconds.
- Default penalties (objective units): priority 1 = 20,000, 2 = 60,000, 3 = 200,000. Configurable per request.
  A penalty must exceed the detour needed to serve a bin, otherwise the solver prefers dropping it. Penalty 0 = free to drop.
- `objective_value` includes penalties and is **not** a distance. Reported distances are recomputed from the matrix.

## Travel costs
The caller supplies `(N+1)x(N+1)` distance (m) and duration (s) matrices (node 0 = depot) and a `source`
(`OSRM_ROAD` or `STRAIGHT_LINE_APPROX`). If omitted, the service falls back to great-circle distance at 25 km/h and labels the
result `STRAIGHT_LINE_APPROX`. That is not road distance.

## Solver status
Search: `PATH_CHEAPEST_ARC` then `GUIDED_LOCAL_SEARCH` within `time_limit_s`. Guided local search does not prove optimality, so
results are `FEASIBLE` (or `TIMED_OUT_FEASIBLE` if OR-Tools reports a partial result). `OPTIMAL` appears only if OR-Tools itself
reports it. `raw_solver_status` exposes the OR-Tools code. Results can vary slightly with machine speed because the search is time-limited.

## Baseline
Deterministic nearest-neighbor over the same eligible bins, vehicles, matrices and constraints (vehicles filled largest-first,
ties by id/index). `distance_reduction_percent = ((baseline - optimized) / baseline) * 100`, returned **only when both plans
serve exactly the same bins**; otherwise `null` with an explanatory note. A zero or missing baseline also yields `null`.
A negative value (optimized longer than baseline) is reported as is.

## Unassigned reasons
`NO_AVAILABLE_VEHICLES`, `DEMAND_EXCEEDS_VEHICLE_CAPACITY`, `TIME_WINDOW_UNREACHABLE`, `UNREACHABLE_WITHIN_MAX_DURATION`
(determined before solving), `FLEET_CAPACITY_EXCEEDED`, and `NOT_SERVED_BY_SOLVER` (the solver judged it not worth serving or
limits were exhausted; the exact binding constraint is not determined).

## Validation
Every returned route is re-evaluated independently from the matrices (capacity, stops, duration, time windows, duplicates).
`validated=true` only with zero violations. The API must not persist a plan unless `validated` is true.

## Known limitations
Single depot; no per-vehicle start location; no pickup/delivery or driver breaks; waste quantity per bin is supplied by the
caller (the API must document how it estimates it from fill % and bin capacity); fuel and emissions are not computed here.
