import pytest

pytest.importorskip("ortools")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

from .helpers import bin_, vehicle  # noqa: E402

client = TestClient(app)
BODY = {"depot": {"lat": 12.9716, "lng": 77.5946}, "bins": [bin_(1, 0.001, 0.001)], "vehicles": [vehicle(1)], "time_limit_s": 1}


def test_health_is_open():
    assert client.get("/health").json() == {"status": "ok"}


def test_requires_service_token(monkeypatch):
    monkeypatch.setenv("OPTIMIZER_SERVICE_TOKEN", "test-token")
    assert client.post("/optimize", json=BODY).status_code == 401
    assert client.post("/optimize", json=BODY, headers={"Authorization": "Bearer nope"}).status_code == 401
    ok = client.post("/optimize", json=BODY, headers={"Authorization": "Bearer test-token"})
    assert ok.status_code == 200 and ok.json()["validated"] is True


def test_fails_closed_when_token_not_configured(monkeypatch):
    monkeypatch.delenv("OPTIMIZER_SERVICE_TOKEN", raising=False)
    assert client.post("/optimize", json=BODY, headers={"Authorization": "Bearer x"}).status_code == 503


def test_invalid_input_is_422(monkeypatch):
    monkeypatch.setenv("OPTIMIZER_SERVICE_TOKEN", "t")
    h = {"Authorization": "Bearer t"}
    assert client.post("/optimize", json={**BODY, "bins": []}, headers=h).status_code == 422
    bad = {**BODY, "bins": [bin_(1, dlat=500)]}
    assert client.post("/optimize", json=bad, headers=h).status_code == 422
    wrong_shape = {**BODY, "matrix": {"distance_m": [[0]], "duration_s": [[0]], "source": "OSRM_ROAD"}}
    assert client.post("/optimize", json=wrong_shape, headers=h).status_code == 422
