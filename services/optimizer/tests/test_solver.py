"""Solver tests: require ortools (pip install -r requirements-dev.txt)."""
import time

import pytest

pytest.importorskip("ortools")

from app.solver import run_optimization  # noqa: E402

from .helpers import bin_, req, vehicle  # noqa: E402

FEASIBLE = {"OPTIMAL", "FEASIBLE", "TIMED_OUT_FEASIBLE"}


def test_valid_plan_is_validated_and_serves_all_bins():
    bins = [bin_(i, dlat=0.002 * i, dlng=0.001 * i) for i in range(1, 7)]
    res = run_optimization(req(bins, [vehicle(1)], time_limit_s=2))
    assert res.solver_status in FEASIBLE
    assert res.validated and res.violations == []
    assert res.cost_source == "STRAIGHT_LINE_APPROX"
    assert {s.bin_id for r in res.routes for s in r.stops} == {b["id"] for b in bins}
    assert res.unassigned == []
    assert res.comparison.baseline_bins_served == 6


def test_capacity_forces_a_split_across_vehicles():
    bins = [bin_(i, dlat=0.003 * i, dlng=-0.002 * i, demand=100) for i in range(1, 7)]
    res = run_optimization(req(bins, [vehicle(1, cap=300), vehicle(2, cap=300)], time_limit_s=2))
    assert res.validated
    assert all(r.load_l <= 300 for r in res.routes)
    assert sum(len(r.stops) for r in res.routes) == 6
    assert len([r for r in res.routes if r.stops]) == 2


def test_bin_larger_than_any_vehicle_is_reported_unassigned_with_reason():
    bins = [bin_(1, 0.001, 0.001, demand=100), bin_(2, 0.002, 0.002, demand=5000)]
    res = run_optimization(req(bins, [vehicle(1, cap=1000)], time_limit_s=1))
    reasons = {u.bin_id: u.reason for u in res.unassigned}
    assert reasons == {"B2": "DEMAND_EXCEEDS_VEHICLE_CAPACITY"}
    assert res.validated


def test_route_duration_limit_excludes_far_bin():
    bins = [bin_(1, 0.001, 0.001), bin_(2, 0.09, 0.09)]  # B2 is ~13 km away (~30+ min each way at 25 km/h)
    res = run_optimization(req(bins, [vehicle(1, dur=900)], time_limit_s=1))
    assert [u.reason for u in res.unassigned] == ["UNREACHABLE_WITHIN_MAX_DURATION"]
    assert all(r.duration_s <= 900 for r in res.routes)


def test_critical_bin_wins_when_capacity_fits_only_one():
    bins = [bin_(1, 0.001, 0.0, demand=100, priority=1),   # close, normal
            bin_(2, 0.03, 0.0, demand=100, priority=3)]    # far, critical
    res = run_optimization(req(bins, [vehicle(1, cap=100)], time_limit_s=2))
    served = [s.bin_id for r in res.routes for s in r.stops]
    assert served == ["B2"]
    assert [u.bin_id for u in res.unassigned] == ["B1"]


def test_no_vehicles_reports_everything_unassigned():
    res = run_optimization(req([bin_(1, 0.001, 0.001)], []))
    assert res.solver_status == "INFEASIBLE" and res.routes == []
    assert [u.reason for u in res.unassigned] == ["NO_AVAILABLE_VEHICLES"]


def test_baseline_comparison_uses_the_same_bins_and_formula():
    bins = [bin_(i, dlat=0.004 * ((i * 7) % 5), dlng=0.004 * ((i * 3) % 5)) for i in range(1, 9)]
    res = run_optimization(req(bins, [vehicle(1)], time_limit_s=3))
    c = res.comparison
    assert c.comparable
    assert c.distance_reduction_percent == round((c.baseline_distance_m - c.optimized_distance_m) / c.baseline_distance_m * 100, 2)
    assert c.optimized_distance_m <= c.baseline_distance_m * 1.0001  # solver should not be worse than greedy here


def test_time_limit_is_respected_and_output_stays_valid():
    bins = [bin_(i, dlat=0.0007 * (i % 17), dlng=0.0009 * (i % 13)) for i in range(1, 61)]
    t0 = time.perf_counter()
    res = run_optimization(req(bins, [vehicle(1, cap=3000), vehicle(2, cap=3000)], time_limit_s=1))
    assert time.perf_counter() - t0 < 8
    assert res.validated and res.solver_status in FEASIBLE


def test_explicit_matrix_source_is_recorded():
    bins = [bin_(1, 0.001, 0.001)]
    n = 2
    m = {"distance_m": [[0, 500], [500, 0]], "duration_s": [[0, 60], [60, 0]], "source": "OSRM_ROAD"}
    res = run_optimization(req(bins, [vehicle(1)], matrix=m, time_limit_s=1))
    assert res.cost_source == "OSRM_ROAD" and res.routes[0].distance_m == 1000
