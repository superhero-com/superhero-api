"""Fail branch CI if a required assembled stage was skipped or undiscovered."""
import sys
import xml.etree.ElementTree as ET

required = {
    "real module providers share sessions and deny unauthorized private previews",
    "scanner backpressure stays durable and a replacement process recovers the same upload",
    "wallet-signed free Like refreshes both sockets, viewer membership and public counts with zero creator rewards",
    "sponsored Like retries and canonical replay count once and reorg removes the indexed event",
    "catalog pagination returns each published identity exactly once",
    "original-derived HLS survives a killed streaming worker and gets acknowledged by the API outbox",
    "real streaming HTTP serves every adaptive asset and range, then restores the same pin after cold restart",
    "a real replacement is restaged from the pinned original and prepared without changing current playback",
    "the actual streaming worker acknowledges a candidate while public sessions still use the original generation",
    "activation changes new signed sessions, retains old cache hits and preserves canonical content and engagement",
    "retained original sessions restore a lost index through both master playback and warm edge authorization",
    "rollback uses retained real media with activation disabled and both generations keep their signed identities",
    "retained replacement sessions restore their generation-specific acknowledgement after rollback",
    "NGINX authorizes all adaptive playlists and cache hits, and signed URLs genuinely expire",
    "adaptive rendition changes and request retries count one measured view",
    "committed content restrictions invalidate live clients; rolled-back metadata stays invisible",
}
suite = "complete hosted module shares upload, media and publication controls across process loss"
cases = {name: [] for name in required}
for case in ET.parse(sys.argv[1]).iter("testcase"):
    name = case.get("name")
    if case.get("classname") == suite and name in cases:
        cases[name].append(case)
invalid = [
    name for name, matches in cases.items()
    if len(matches) != 1 or any(matches[0].find(tag) is not None for tag in ("skipped", "failure", "error"))
]
if invalid:
    sys.exit("Required assembled assertions missing, duplicated or unsuccessful: " + ", ".join(sorted(invalid)))
