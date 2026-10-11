from app.problem import Problem, VehicleSpec
from app.schemas import OptimizeRequest

DEPOT = {"lat": 12.9716, "lng": 77.5946}


def line_problem(positions=(0, 1000, 3000, 2000), vehicles=None, demand=100, service=0):
    """Depot at position positions[0]; bins on a line. dist = |dx| meters, dur = dist/10 (10 m/s)."""
    n = len(positions)
    dist = [[abs(positions[i] - positions[j]) for j in range(n)] for i in range(n)]
    dur = [[d // 10 for d in row] for row in dist]
    return Problem(
        ids=["DEPOT"] + [f"B{i}" for i in range(1, n)],
        demand=[0] + [demand] * (n - 1),
        service=[0] + [service] * (n - 1),
        priority=[1] * n,
        window=[None] * n,
        dist=dist,
        dur=dur,
        vehicles=vehicles or [VehicleSpec("V1", 1000, 50, 100_000)],
    )


def req(bins, vehicles, **kw) -> OptimizeRequest:
    return OptimizeRequest(depot=DEPOT, bins=bins, vehicles=vehicles, **kw)


def bin_(i, dlat=0.0, dlng=0.0, demand=100, priority=1, **kw):
    return {"id": f"B{i}", "lat": DEPOT["lat"] + dlat, "lng": DEPOT["lng"] + dlng,
            "demand_liters": demand, "priority": priority, "service_s": kw.pop("service_s", 60), **kw}


def vehicle(i, cap=1000, dur=8 * 3600, stops=None):
    return {"id": f"V{i}", "capacity_liters": cap, "max_duration_s": dur, **({"max_stops": stops} if stops else {})}
