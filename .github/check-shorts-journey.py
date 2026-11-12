"""Fail branch CI if a required assembled stage was skipped or undiscovered."""
import sys
import xml.etree.ElementTree as ET

required = {
    "real module providers share sessions and deny unauthorized private previews",
    "scanner backpressure stays durable and a replacement process recovers the same upload",
    "plugin commits refresh both sockets; API catalog and creator totals distinguish pending Likes",
    "original-derived HLS survives a killed streaming worker and gets acknowledged by the API outbox",
    "real streaming HTTP serves every adaptive asset and range, then restores the same pin after cold restart",
}
report = ET.parse(sys.argv[1])
passed = {
    case.get("name")
    for case in report.iter("testcase")
    if case.get("classname") == "complete hosted module shares upload, media and publication controls across process loss"
    and not any(case.find(tag) is not None for tag in ("skipped", "failure", "error"))
}
if required - passed:
    sys.exit("Missing successful assembled assertions: " + ", ".join(sorted(required - passed)))
