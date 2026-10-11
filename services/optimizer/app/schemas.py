"""Request/response contracts for the optimizer. Units: meters, seconds, liters. Node 0 is always the depot."""
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

NonNegInt = Annotated[int, Field(ge=0)]
SolverStatus = Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE", "TIMED_OUT_FEASIBLE", "FAILED"]
CostSource = Literal["OSRM_ROAD", "STRAIGHT_LINE_APPROX"]


class Coord(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class BinIn(Coord):
    id: str = Field(min_length=1, max_length=64)
    demand_liters: NonNegInt  # estimated waste to collect
    service_s: NonNegInt = 180
    priority: int = Field(default=1, ge=1, le=3)  # 1 normal, 2 high, 3 critical
    # Optional window [start, end] in seconds after shift start, applied to the *start of service*.
    time_window: tuple[NonNegInt, NonNegInt] | None = None

    @field_validator("time_window")
    @classmethod
    def _ordered(cls, v):
        if v is not None and v[0] > v[1]:
            raise ValueError("time_window start must be <= end")
        return v


class VehicleIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    capacity_liters: int = Field(gt=0)
    max_stops: int | None = Field(default=None, gt=0)  # operational limit, separate from liters
    max_duration_s: int = Field(gt=0)


class TravelMatrix(BaseModel):
    """(N+1)x(N+1): row/col 0 = depot, row/col k = bins[k-1]."""
    distance_m: list[list[NonNegInt]]
    duration_s: list[list[NonNegInt]]
    source: CostSource


class Weights(BaseModel):
    """Penalty for leaving a bin unserved, in objective units (meters for MIN_DISTANCE, seconds for MIN_DURATION).
    Penalty 0 means the bin may be dropped for free."""
    unserved_penalty_priority_1: int = Field(default=20_000, ge=0)
    unserved_penalty_priority_2: int = Field(default=60_000, ge=0)
    unserved_penalty_priority_3: int = Field(default=200_000, ge=0)

    def for_priority(self, p: int) -> int:
        return {1: self.unserved_penalty_priority_1, 2: self.unserved_penalty_priority_2,
                3: self.unserved_penalty_priority_3}[p]


class OptimizeRequest(BaseModel):
    depot: Coord
    vehicles: list[VehicleIn]  # may be empty -> everything is reported unassigned
    bins: list[BinIn] = Field(min_length=1, max_length=2000)
    matrix: TravelMatrix | None = None  # omitted -> labeled straight-line approximation
    weights: Weights = Field(default_factory=Weights)
    objective: Literal["MIN_DISTANCE", "MIN_DURATION"] = "MIN_DISTANCE"
    time_limit_s: int = Field(default=10, ge=1, le=120)

    @model_validator(mode="after")
    def _unique_ids(self):
        if len({b.id for b in self.bins}) != len(self.bins):
            raise ValueError("bin ids must be unique")
        if len({v.id for v in self.vehicles}) != len(self.vehicles):
            raise ValueError("vehicle ids must be unique")
        return self


class StopOut(BaseModel):
    bin_id: str
    order: int
    start_service_s: int
    service_s: int
    load_after_l: int


class RouteOut(BaseModel):
    vehicle_id: str
    stops: list[StopOut]
    distance_m: int
    driving_s: int
    service_s: int
    duration_s: int  # depot departure -> depot return, includes any waiting for time windows
    load_l: int
    utilization_percent: float  # load / vehicle capacity


class Unassigned(BaseModel):
    bin_id: str
    reason: str
    detail: str


class Violation(BaseModel):
    code: str
    detail: str
    vehicle_id: str | None = None


class Comparison(BaseModel):
    comparable: bool
    baseline_distance_m: int | None
    optimized_distance_m: int
    distance_reduction_percent: float | None  # ((baseline - optimized) / baseline) * 100
    baseline_bins_served: int
    optimized_bins_served: int
    note: str


class OptimizeResponse(BaseModel):
    solver_status: SolverStatus
    raw_solver_status: int | None  # OR-Tools RoutingModel status code, for transparency
    cost_source: CostSource
    objective: str
    objective_value: int | None  # includes unserved penalties; not a distance
    routes: list[RouteOut]
    baseline_routes: list[RouteOut]
    unassigned: list[Unassigned]
    violations: list[Violation]
    validated: bool  # True only if independent re-evaluation found zero violations
    comparison: Comparison
    solve_time_ms: int
    assumptions: dict
