"""Shared contract between the Phase 2 models.  SHARED (foundation).

The demand forecast (A, ml/demand_forecast) and the site-location model (B,
ml/site_location) train on different machines. The only thing they exchange is a
demand artifact directory (see demand_artifact.py), so either side can change its
model freely as long as the artifact stays valid.
"""

from ml.contract.demand_artifact import (
    SCHEMA_VERSION,
    DemandArtifact,
    Manifest,
    read_artifact,
    write_artifact,
)
from ml.contract.regions import REGIONS, Region

__all__ = ["SCHEMA_VERSION", "DemandArtifact", "Manifest", "REGIONS", "Region", "read_artifact", "write_artifact"]
