from dataclasses import dataclass


@dataclass(frozen=True)
class VehicleSpec:
    id: str
    capacity: int
    max_stops: int
    max_duration_s: int


@dataclass
class Problem:
    """Reduced problem containing only eligible bins. Index 0 = depot; arrays are node-indexed."""
    ids: list[str]
    demand: list[int]
    service: list[int]
    priority: list[int]
    window: list[tuple[int, int] | None]
    dist: list[list[int]]
    dur: list[list[int]]
    vehicles: list[VehicleSpec]

    @property
    def n(self) -> int:
        return len(self.ids)
