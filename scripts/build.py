"""Assemble index.html: inject the baked DEM into src/index.html."""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    dem = json.load(open(os.path.join(ROOT, "data", "dem.json")))
    src = open(os.path.join(ROOT, "src", "index.html"), encoding="utf-8").read()
    if "__DEM_JSON__" not in src:
        sys.exit("build: marker __DEM_JSON__ missing")
    payload = json.dumps(dem, separators=(",", ":"))
    assert "</script" not in payload
    out = src.replace("__DEM_JSON__", payload)
    open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8", newline="\n").write(out)
    print("built index.html  %.1f KB  (dem %.1f KB)" %
          (len(out) / 1024, len(payload) / 1024))


if __name__ == "__main__":
    main()
