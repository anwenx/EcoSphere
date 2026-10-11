"""Independent re-evaluation of routes from the travel matrices. Reported metrics come from here, not from the
solver, and every constraint is re-checked so a solver/model bug cannot silently produce an invalid plan."""
from .problem import Problem
from .schemas import RouteOut, StopOut, Violation


def evaluate_route(p: Problem, k: int, seq: list[int]) -> tuple[RouteOut, list[Violation]]:
    v = p.vehicles[k]
    violations: list[Violation] = []
    t, cur, load, dist, driving, service = 0, 0, 0, 0, 0, 0
    stops: list[StopOut] = []

    for order, j in enumerate(seq, start=1):
        travel = p.dur[cur][j]
        start = t + travel
        w = p.window[j]
        if w is not None:
            start = max(start, w[0])
            if start > w[1]:
                violations.append(Violation(code="TIME_WINDOW", vehicle_id=v.id,
                                            detail=f"{p.ids[j]} service would start at {start}s after window end {w[1]}s"))
        load += p.demand[j]
        dist += p.dist[cur][j]
        driving += travel
        service += p.service[j]
        stops.append(StopOut(bin_id=p.ids[j], order=order, start_service_s=start,
                             service_s=p.service[j], load_after_l=load))
        t, cur = start + p.service[j], j

    if seq:
        dist += p.dist[cur][0]
        driving += p.dur[cur][0]
        t += p.dur[cur][0]

    if load > v.capacity:
        violations.append(Violation(code="CAPACITY", vehicle_id=v.id, detail=f"load {load} L > capacity {v.capacity} L"))
    if len(seq) > v.max_stops:
        violations.append(Violation(code="MAX_STOPS", vehicle_id=v.id, detail=f"{len(seq)} stops > limit {v.max_stops}"))
    if t > v.max_duration_s:
        violations.append(Violation(code="MAX_DURATION", vehicle_id=v.id, detail=f"duration {t}s > limit {v.max_duration_s}s"))

    route = RouteOut(vehicle_id=v.id, stops=stops, distance_m=dist, driving_s=driving, service_s=service,
                     duration_s=t, load_l=load, utilization_percent=round(100 * load / v.capacity, 1))
    return route, violations


def validate_solution(p: Problem, routes: list[list[int]]) -> tuple[list[RouteOut], list[Violation]]:
    outs: list[RouteOut] = []
    violations: list[Violation] = []
    seen: dict[int, int] = {}
    for k, seq in enumerate(routes):
        route, vs = evaluate_route(p, k, seq)
        outs.append(route)
        violations += vs
        for j in seq:
            if j in seen:
                violations.append(Violation(code="DUPLICATE_BIN", vehicle_id=p.vehicles[k].id,
                                            detail=f"{p.ids[j]} appears in more than one route"))
            seen[j] = k
            if not 1 <= j < p.n:
                violations.append(Violation(code="UNKNOWN_NODE", vehicle_id=p.vehicles[k].id, detail=f"node {j}"))
    return outs, violations


def reduction_percent(baseline: int | None, optimized: int) -> float | None:
    """((baseline - optimized) / baseline) * 100; None when the baseline is missing or zero."""
    if baseline is None or baseline <= 0:
        return None
    return round((baseline - optimized) / baseline * 100, 2)
