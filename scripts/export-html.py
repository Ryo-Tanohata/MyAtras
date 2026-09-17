#!/usr/bin/env python3
"""Build the standalone dist/myatras-clouds.html from the served dist/ tree.

Every observation is inlined byte for byte from the files the page serves, after
its SHA-256 is checked against the manifest that recorded the download. Nothing is
resampled, recoloured or regenerated here: a frame that does not match is a build
error, not something to paper over. Standard library only.
"""
import base64
import hashlib
import json
import mimetypes
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
OUT = DIST / "myatras-clouds.html"
SCRIPT_TAG = re.compile(r'<script src="([^"]+)"></script>')
STYLE_TAG = re.compile(r'<link rel="stylesheet" href="([^"]+)">')


def read_asset(relative, expected_sha256=None):
    path = DIST / relative
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if expected_sha256 and digest != expected_sha256:
        raise SystemExit(
            f"SHA-256 mismatch for {relative}: file {digest}, manifest {expected_sha256}"
        )
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii")), digest


def literal(value):
    """JSON that is safe to embed in an inline <script>."""
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("<", "\u003c")
        .replace(" ", "\u2028")
        .replace(" ", "\u2029")
    )


def script(text):
    if "</script" in text.lower():
        raise SystemExit("inline script would close its own tag")
    return "<script>" + text + "</script>"


def earth_and_snapshot():
    earth, _ = read_asset("assets/earth.jpg")
    manifest = json.loads((DIST / "weather/snapshot.json").read_text(encoding="utf-8"))
    snapshot = {}
    for product, entry in manifest.items():
        url, _ = read_asset("weather/" + entry["file"], entry.get("sha256"))
        snapshot[product] = {"time": entry["time"], "url": url}
        print("  snapshot %-9s %s" % (product, entry["time"]))
    return script(
        "window.GEO_EARTH_IMAGE=%s;window.GEO_WEATHER_SNAPSHOT=%s;"
        % (literal(earth), literal(snapshot))
    )


def sequence():
    manifest = json.loads(
        (DIST / "weather/sequence/manifest.json").read_text(encoding="utf-8")
    )
    bundle = {}
    for product, frames in manifest.items():
        out = []
        for frame in frames:
            url, digest = read_asset(
                "weather/sequence/" + frame["file"], frame.get("sha256")
            )
            out.append(
                {
                    "time": frame["time"],
                    "url": url,
                    "source": frame["source"],
                    "sha256": digest,
                }
            )
        if len(out) < 2:
            raise SystemExit("%s needs at least two observation times" % product)
        times = [f["time"] for f in out]
        if times != sorted(times) or len(set(times)) != len(times):
            raise SystemExit("%s observation times are not distinct and ordered" % product)
        bundle[product] = out
        print("  sequence %-9s %d frames %s → %s" % (product, len(out), times[0], times[-1]))
    return script("window.GEO_WEATHER_SEQUENCE=%s;" % literal(bundle))


def amv():
    data = json.loads((DIST / "data/amv.json").read_text(encoding="utf-8"))
    print("  wind     %s  %d tracers" % (data["time"], len(data["points"])))
    return script("window.GEO_AMV_SNAPSHOT=%s;" % literal(data))


def main():
    html = (DIST / "index.html").read_text(encoding="utf-8")
    print("inlining observations")
    html = html.replace("<!--bundle:earth-->", earth_and_snapshot())
    html = html.replace("<!--bundle:sequence-->", sequence())
    html = html.replace("<!--bundle:amv-->", amv())
    html = STYLE_TAG.sub(
        lambda m: "<style>" + (DIST / m.group(1)).read_text(encoding="utf-8") + "</style>",
        html,
    )
    html = SCRIPT_TAG.sub(
        lambda m: script((DIST / m.group(1)).read_text(encoding="utf-8")), html
    )
    for leftover in ("<!--bundle:", '<script src=', 'rel="stylesheet"'):
        if leftover in html:
            raise SystemExit("unresolved reference remains: " + leftover)
    OUT.write_text(html, encoding="utf-8")
    print("wrote %s (%.1f MB)" % (OUT.relative_to(ROOT), OUT.stat().st_size / 1e6))


if __name__ == "__main__":
    sys.exit(main())
