"""Forecast regions: the California load areas EIA-930 reports hourly demand for.  SHARED.

Region ids are the EIA-930 codes. CAISO is split into its three IOU sub-regions;
the other California balancing authorities are whole regions. VEA (a CAISO
sub-region in Nevada) and PACW/NEVP (mostly out of state) are left out.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    eia_ba: str  # EIA-930 balancing authority code
    eia_subregion: str | None  # EIA-930 sub-region code, when the region is part of a BA
    balancing_authority: str  # short name used by the Explore layers (data/explore/balancing_authorities_ca.geojson)
    utilities: tuple[str, ...]  # utility short_names (data/explore/utilities_ca.geojson) whose territory defines the region


REGIONS: dict[str, Region] = {
    r.id: r
    for r in (
        Region("PGAE", "PG&E area (CAISO)", "CISO", "PGAE", "CAISO", ("PG&E",)),
        Region("SCE", "SCE area (CAISO)", "CISO", "SCE", "CAISO", ("SCE",)),
        Region("SDGE", "SDG&E area (CAISO)", "CISO", "SDGE", "CAISO", ("SDG&E",)),
        Region("LDWP", "Los Angeles Department of Water and Power", "LDWP", None, "LADWP", ("LADWP",)),
        Region("BANC", "Balancing Authority of Northern California", "BANC", None, "BANC", ("SMUD",)),
        Region("IID", "Imperial Irrigation District", "IID", None, "IID", ("IID",)),
        Region("TIDC", "Turlock Irrigation District", "TIDC", None, "TIDC", ("TID",)),
    )
}
