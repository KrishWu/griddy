"""Progress follows completed pipeline stages and never announces failed runs as complete."""
import importlib
import json

import pytest
from fastapi.testclient import TestClient

from app.builder.service import list_presets
from app.contract import ScenarioResult
from app.main import app
from app.simulate import profiles, weather

progress = importlib.import_module("app.builder.run_progress")
pipeline = importlib.import_module("app.pipeline")


@pytest.fixture(scope="module")
def baseline():
    patch = pytest.MonkeyPatch()
    def offline(*args, **kwargs):
        raise weather.WeatherUnavailable("offline test")
    patch.setattr(weather, "build_site_frame", offline)
    patch.setattr(pipeline, "site_findings", lambda *args: [])
    profiles.clear_weather_cache()
    result = pipeline.run_scenario(list_presets()[0])
    yield result
    patch.undo()
    profiles.clear_weather_cache()


@pytest.fixture
def stages(monkeypatch, baseline):
    calls = []
    def step(name, value):
        def run(*args):
            calls.append(name)
            return value
        return run
    monkeypatch.setattr(progress, "get_catalog", step("catalog", object()))
    monkeypatch.setattr(progress, "simulate", step("simulate", baseline.simulation))
    monkeypatch.setattr(progress, "evaluate", step("evaluate", baseline.evaluation))
    monkeypatch.setattr(progress, "stress_test", step("stress", []))
    monkeypatch.setattr(progress, "site_findings", step("site", []))
    return calls


def test_progress_advances_only_after_stage_returns(stages, baseline):
    stream = progress.run_progress(baseline.scenario)
    for index, percent in enumerate((0, 20, 40, 60, 80)):
        event = json.loads(next(stream))
        assert event["type"] == "progress"
        assert event["percent"] == percent
        assert len(stages) == index
    result = json.loads(next(stream))
    assert result["type"] == "result"
    assert stages == ["catalog", "simulate", "evaluate", "stress", "site"]
    decoded = ScenarioResult.model_validate(result["result"])
    assert decoded.simulation == baseline.simulation
    assert decoded.evaluation == baseline.evaluation
    assert decoded.scenario == baseline.scenario
    assert list(stream) == []


def test_optional_site_failure_still_returns_result(monkeypatch, stages, baseline):
    def unavailable(*args):
        raise RuntimeError("site API unavailable")
    monkeypatch.setattr(progress, "site_findings", unavailable)
    events = [json.loads(line) for line in progress.run_progress(baseline.scenario)]
    result = ScenarioResult.model_validate(events[-1]["result"])
    assert result.findings[-1].id == "site_findings_error"
    assert result.findings[-1].severity == "info"


def test_failed_simulation_has_no_result_or_completed_progress(monkeypatch, stages, baseline):
    def broken(*args):
        raise ValueError("private internal details")
    monkeypatch.setattr(progress, "simulate", broken)
    events = [json.loads(line) for line in progress.run_progress(baseline.scenario)]
    assert events[-1]["type"] == "error"
    assert "private internal details" not in events[-1]["message"]
    assert not any(e["type"] == "result" for e in events)
    assert max(e["percent"] for e in events if e["type"] == "progress") < 100


def test_stream_route_returns_contract_and_prevents_proxy_buffering(stages, baseline):
    response = TestClient(app).post("/api/projects/run-stream", json=baseline.scenario.model_dump(mode="json"))
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert response.headers["x-accel-buffering"] == "no"
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[0]["percent"] == 0
    assert ScenarioResult.model_validate(events[-1]["result"]).simulation == baseline.simulation


def test_stream_route_validates_before_starting():
    assert TestClient(app).post("/api/projects/run-stream", json={}).status_code == 422
