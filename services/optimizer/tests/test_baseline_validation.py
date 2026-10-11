"""Pure-logic tests (no OR-Tools needed)."""
import pytest

from app.baseline import nearest_neighbor
from app.problem import VehicleSpec
from app.routing import InputError, approximate_matrices, haversine_m, validate_matrix
from app.schemas import BinIn, Coord, OptimizeRequest, TravelMatrix
from app.validation import evaluate_route, reduction_percent, validate_solution
from pydantic import ValidationError

from .helpers import DEPOT, bin_, line_problem, req, vehicle


def test_nearest_neighbor_is_deterministic_and_correct_on_a_line():
    p = line_problem()  # depot 0, B1=1000, B2=3000, B3=2000
    routes = nearest_neighbor(p)
    assert routes == [[1, 3, 2]]  # nearest first: 1000 -> 2000 -> 3000
    assert nearest_neighbor(p) == routes
    outs, violations = validate_solution(p, routes)
    assert violations == []
    assert outs[0].distance_m == 1000 + 1000 + 1000 + 3000  # 6000 including the return leg


def test_baseline_respects_capacity_and_uses_second_vehicle():
    p = line_problem(vehicles=[VehicleSpec("V1", 200, 50, 100_000), VehicleSpec("V2", 200, 50, 100_000)])
    routes = nearest_neighbor(p)
    assert sorted(j for r in routes for j in r) == [1, 2, 3]
    assert all(sum(p.demand[j] for j in r) <= 200 for r in routes)


def test_baseline_leaves_bins_unserved_when_duration_is_too_short():
    p = line_problem(vehicles=[VehicleSpec("V1", 1000, 50, 250)])  # 250 s ~ 2.5 km at 10 m/s
    routes = nearest_neighbor(p)
    served = {j for r in routes for j in r}
    assert 2 not in served  # B2 is 3 km away, round trip 600 s


def test_reduction_formula_and_zero_baseline_handling():
    assert reduction_percent(100, 80) == 20.0
    assert reduction_percent(100, 120) == -20.0  # longer than baseline is reported honestly
    assert reduction_percent(0, 0) is None
    assert reduction_percent(None, 10) is None


def test_validation_detects_capacity_duplicate_and_duration_violations():
    p = line_problem(demand=600, vehicles=[VehicleSpec("V1", 1000, 1, 100_000), VehicleSpec("V2", 1000, 5, 100)])
    _, vs = validate_solution(p, [[1, 2], [2]])
    codes = {v.code for v in vs}
    assert {"CAPACITY", "MAX_STOPS", "DUPLICATE_BIN", "MAX_DURATION"} <= codes


def test_time_window_wait_and_violation():
    p = line_problem(service=0)
    p.window[1] = (500, 600)  # arrival at 100 s -> waits until 500
    route, vs = evaluate_route(p, 0, [1])
    assert vs == [] and route.stops[0].start_service_s == 500
    p.window[1] = (0, 50)  # arrival at 100 s is too late
    _, vs = evaluate_route(p, 0, [1])
    assert [v.code for v in vs] == ["TIME_WINDOW"]


def test_haversine_and_approximation_matrix():
    a, b = Coord(lat=12.9716, lng=77.5946), Coord(lat=12.9716, lng=77.6046)
    assert 1000 < haversine_m(a, b) < 1100  # ~0.01 deg of longitude at this latitude
    dist, dur = approximate_matrices(a, [BinIn(id="x", lat=b.lat, lng=b.lng, demand_liters=1)])
    assert dist[0][1] == dist[1][0] > 0 and dist[0][0] == 0 and dur[0][1] > 0


def test_schema_rejects_bad_input():
    with pytest.raises(ValidationError):
        req([bin_(1, dlat=200)], [vehicle(1)])  # latitude out of range
    with pytest.raises(ValidationError):
        req([], [vehicle(1)])  # empty bin list
    with pytest.raises(ValidationError):
        req([bin_(1), bin_(1)], [vehicle(1)])  # duplicate ids
    with pytest.raises(ValidationError):
        req([bin_(1, demand=-5)], [vehicle(1)])  # negative quantity
    with pytest.raises(ValidationError):
        req([bin_(1, time_window=(10, 5))], [vehicle(1)])


def test_matrix_shape_is_validated():
    m = TravelMatrix(distance_m=[[0, 1], [1, 0]], duration_s=[[0, 1], [1, 0]], source="OSRM_ROAD")
    validate_matrix(m, 2)
    with pytest.raises(InputError):
        validate_matrix(m, 3)
