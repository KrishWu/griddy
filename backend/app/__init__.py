"""GridForge backend.  SHARED (foundation).

Loads backend/.env (git-ignored) so API keys are available via os.environ to the
server, tests and prep scripts alike. Copy backend/.env.example to get started.
"""

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

# Repo-level data/ folder. Always build data paths from this (e.g. DATA_DIR / "simulate"),
# never from the working directory, which is backend/ under uvicorn and pytest.
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
