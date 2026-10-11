"""CVRP with capacity, max stops, route duration, optional time windows and priority-weighted unserved penalties,
solved with OR-Tools (PATH_CHEAPEST_ARC + GUIDED_LOCAL_SEARCH). Guided local search is a metaheuristic: it never
proves optimality, so results are reported as FEASIBLE / TIMED_OUT_FEASIBLE, not OPTIMAL, unless the solver itself
reports ROUTING_OPTIMAL."""
import time

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .baseline import nearest_neighbor
from .problem import Problem, VehicleSpec
from .routing import DEFAULT_SPEED_KMH, InputError, approximate_matrices, validate_matrix
from .schemas import Comparison, OptimizeRequest, OptimizeResponse, Unassigned, Violation
from .validation import reduction_percent, validate_solution

# OR-Tools RoutingModel status codes
_NOT_SOLVED, _SUCCESS, _PARTIAL, _FAIL, _FAIL_TIMEOUT, _INVALID, _INFEASIBLE, _OPTIMAL = range(8)


def _map_status(raw: int, has_solution: bool) -> str:
    if has_solution:
        if raw == _OPTIMAL:
            return "OPTIMAL"
        if raw == _PARTIAL:
            return "TIMED_OUT_FEASIBLE"
        return "FEASIBLE"
    return "INFEASIBLE" if raw == _INFEASIBLE else "FAILED"


def build_problem(req: OptimizeRequest, dist, dur) -> tuple[Problem, list[Unassigned]]:
    """Filters bins that cannot be served by any vehicle, recording an explicit reason for each."""
    max_cap = max(v.capacity_liters for v in req.vehicles)
    max_dur = max(v.max_duration_s for v in req.vehicles)
    keep = [0]
    rejected: list[Unassigned] = []
    for k, b in enumerate(req.bins, start=1):
        start = dur[0][k]
        if b.time_window is not None:
            start = max(start, b.time_window[0])
        if b.demand_liters > max_cap:
            rejected.append(Unassigned(bin_id=b.id, reason="DEMAND_EXCEEDS_VEHICLE_CAPACITY",
                                       detail=f"Estimated {b.demand_liters} L exceeds the largest vehicle ({max_cap} L)."))
        elif b.time_window is not None and start > b.time_window[1]:
            rejected.append(Unassigned(bin_id=b.id, reason="TIME_WINDOW_UNREACHABLE",
                                       detail="Earliest possible arrival is after the end of its time window."))
        elif start + b.service_s + dur[k][0] > max_dur:
            rejected.append(Unassigned(bin_id=b.id, reason="UNREACHABLE_WITHIN_MAX_DURATION",
                                       detail=f"Round trip from the depot plus service exceeds the longest allowed route ({max_dur}s)."))
        else:
            keep.append(k)

    bins = [None, *req.bins]
    problem = Problem(
        ids=["DEPOT", *[bins[k].id for k in keep[1:]]],
        demand=[0, *[bins[k].demand_liters for k in keep[1:]]],
        service=[0, *[bins[k].service_s for k in keep[1:]]],
        priority=[1, *[bins[k].priority for k in keep[1:]]],
        window=[None, *[bins[k].time_window for k in keep[1:]]],
        dist=[[dist[i][j] for j in keep] for i in keep],
        dur=[[dur[i][j] for j in keep] for i in keep],
        vehicles=[VehicleSpec(v.id, v.capacity_liters, v.max_stops or len(req.bins), v.max_duration_s)
                  for v in req.vehicles],
    )
    return problem, rejected


def solve_vrp(p: Problem, req: OptimizeRequest):
    """Returns (routes as node-index lists per vehicle, raw status, objective value | None)."""
    manager = pywrapcp.RoutingIndexManager(p.n, len(p.vehicles), 0)
    routing = pywrapcp.RoutingModel(manager)
    node = manager.IndexToNode

    cost = p.dist if req.objective == "MIN_DISTANCE" else p.dur
    cost_cb = routing.RegisterTransitCallback(lambda i, j: cost[node(i)][node(j)])
    routing.SetArcCostEvaluatorOfAllVehicles(cost_cb)

    demand_cb = routing.RegisterUnaryTransitCallback(lambda i: p.demand[node(i)])
    routing.AddDimensionWithVehicleCapacity(demand_cb, 0, [v.capacity for v in p.vehicles], True, "Load")

    stop_cb = routing.RegisterUnaryTransitCallback(lambda i: 0 if node(i) == 0 else 1)
    routing.AddDimensionWithVehicleCapacity(stop_cb, 0, [v.max_stops for v in p.vehicles], True, "Stops")

    # Cumul at a node = time service starts there; transit = travel + service at the origin node. Waiting = slack.
    time_cb = routing.RegisterTransitCallback(lambda i, j: p.dur[node(i)][node(j)] + p.service[node(i)])
    horizon = max(v.max_duration_s for v in p.vehicles)
    routing.AddDimension(time_cb, horizon, horizon, True, "Time")
    time_dim = routing.GetDimensionOrDie("Time")
    for k, v in enumerate(p.vehicles):
        time_dim.CumulVar(routing.End(k)).SetRange(0, v.max_duration_s)
    for j in range(1, p.n):
        if p.window[j] is not None:
            time_dim.CumulVar(manager.NodeToIndex(j)).SetRange(*p.window[j])

    # Every bin is optional at a priority-weighted penalty, so unservable bins are reported rather than hidden.
    for j in range(1, p.n):
        routing.AddDisjunction([manager.NodeToIndex(j)], req.weights.for_priority(p.priority[j]))

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(req.time_limit_s)

    solution = routing.SolveWithParameters(params)
    raw = routing.status()
    if solution is None:
        return None, raw, None

    routes: list[list[int]] = []
    for k in range(len(p.vehicles)):
        idx, seq = routing.Start(k), []
        while not routing.IsEnd(idx):
            n_ = node(idx)
            if n_ != 0:
                seq.append(n_)
            idx = solution.Value(routing.NextVar(idx))
        routes.append(seq)
    return routes, raw, solution.ObjectiveValue()


def _empty_comparison(note: str) -> Comparison:
    return Comparison(comparable=False, baseline_distance_m=None, optimized_distance_m=0,
                      distance_reduction_percent=None, baseline_bins_served=0, optimized_bins_served=0, note=note)


def run_optimization(req: OptimizeRequest) -> OptimizeResponse:
    t0 = time.perf_counter()
    n_full = len(req.bins) + 1
    if req.matrix is None:
        dist, dur = approximate_matrices(req.depot, req.bins)
        source = "STRAIGHT_LINE_APPROX"
    else:
        validate_matrix(req.matrix, n_full)
        dist, dur, source = req.matrix.distance_m, req.matrix.duration_s, req.matrix.source

    assumptions: dict = {
        "search": "PATH_CHEAPEST_ARC + GUIDED_LOCAL_SEARCH",
        "time_limit_s": req.time_limit_s,
        "weights": req.weights.model_dump(),
        "vehicles_start_and_end_at": "depot",
    }
    if source == "STRAIGHT_LINE_APPROX":
        assumptions["approximation"] = f"great-circle distance at {DEFAULT_SPEED_KMH} km/h; NOT road distance"

    def finish(status, raw, obj, routes, baseline, unassigned, violations, validated, comparison):
        return OptimizeResponse(
            solver_status=status, raw_solver_status=raw, cost_source=source, objective=req.objective,
            objective_value=obj, routes=routes, baseline_routes=baseline, unassigned=unassigned,
            violations=violations, validated=validated, comparison=comparison,
            solve_time_ms=round((time.perf_counter() - t0) * 1000), assumptions=assumptions)

    if not req.vehicles:
        un = [Unassigned(bin_id=b.id, reason="NO_AVAILABLE_VEHICLES", detail="No vehicles were provided.") for b in req.bins]
        return finish("INFEASIBLE", None, None, [], [], un, [], True, _empty_comparison("No vehicles available."))

    problem, rejected = build_problem(req, dist, dur)
    if problem.n == 1:
        return finish("INFEASIBLE", None, None, [], [], rejected, [], True,
                      _empty_comparison("No bin can be served by any vehicle."))

    base_routes, base_violations = validate_solution(problem, nearest_neighbor(problem))
    seqs, raw, obj = solve_vrp(problem, req)
    if seqs is None:
        return finish(_map_status(raw, False), raw, None, [], base_routes, rejected,
                      [Violation(code="SOLVER_NO_SOLUTION", detail=f"OR-Tools status {raw}")], False,
                      _empty_comparison("No optimized solution was produced."))

    routes, violations = validate_solution(problem, seqs)
    served = {j for seq in seqs for j in seq}
    unserved = [j for j in range(1, problem.n) if j not in served]
    total_demand = sum(problem.demand[j] for j in range(1, problem.n))
    total_cap = sum(v.capacity for v in problem.vehicles)
    for j in unserved:
        if total_demand > total_cap:
            reason, detail = "FLEET_CAPACITY_EXCEEDED", f"Eligible demand {total_demand} L exceeds total fleet capacity {total_cap} L."
        else:
            reason = "NOT_SERVED_BY_SOLVER"
            detail = ("Not part of the best plan found: serving it cost more than its unserved penalty, "
                      "or fleet duration/stop limits were exhausted.")
        rejected.append(Unassigned(bin_id=problem.ids[j], reason=reason, detail=detail))

    opt_dist = sum(r.distance_m for r in routes)
    base_dist = sum(r.distance_m for r in base_routes)
    base_served = {s.bin_id for r in base_routes for s in r.stops}
    opt_served = {s.bin_id for r in routes for s in r.stops}
    comparable = bool(opt_served) and opt_served == base_served and not base_violations
    if comparable:
        note = "Same bins served by both plans; same matrices and constraints."
    else:
        note = (f"Not comparable: baseline served {len(base_served)} bins, optimized served {len(opt_served)}. "
                "Distances are only compared when both plans serve exactly the same bins.")
    comparison = Comparison(
        comparable=comparable,
        baseline_distance_m=base_dist if comparable else None,
        optimized_distance_m=opt_dist,
        distance_reduction_percent=reduction_percent(base_dist, opt_dist) if comparable else None,
        baseline_bins_served=len(base_served), optimized_bins_served=len(opt_served), note=note)

    return finish(_map_status(raw, True), raw, obj, routes, base_routes, rejected, violations,
                  not violations, comparison)
