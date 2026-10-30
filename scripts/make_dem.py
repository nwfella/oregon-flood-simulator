"""Build a compact DEM + coastline dataset for the Oregon tsunami simulator.

Source: AWS Open Data terrain tiles (terrarium, z=10), which encode elevation in
RGB as (R*256 + G + B/256) - 32768.  Ocean is negative (ETOPO/GEBCO bathy).

Output: data/dem.json  ->  {lon0,lat0,dlon,dlat,nx,ny,emin,estep,elev(base64 q8)}
"""
import io, json, math, os, sys, threading, urllib.request, zlib, base64
import numpy as np

Z = 10
LON0, LON1 = -126.50, -121.30
LAT0, LAT1 = 41.90, 46.40
NX, NY = 723, 900

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
CACHE = os.path.join(OUT, "tiles")
os.makedirs(CACHE, exist_ok=True)


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def decode_png(data):
    """Minimal 8-bit RGB / RGBA non-interlaced PNG decoder -> (h,w,3) uint8."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos = 8
    idat = []
    w = h = bit = ct = None
    while pos < len(data):
        ln = int.from_bytes(data[pos:pos + 4], "big")
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w = int.from_bytes(chunk[0:4], "big")
            h = int.from_bytes(chunk[4:8], "big")
            bit = chunk[8]
            ct = chunk[9]
            assert bit == 8 and ct in (2, 6), (bit, ct)
            assert chunk[12] == 0, "interlaced unsupported"
        elif typ == b"IDAT":
            idat.append(chunk)
        elif typ == b"IEND":
            break
    raw = zlib.decompress(b"".join(idat))
    nch = 3 if ct == 2 else 4
    stride = w * nch
    out = np.zeros((h, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.int32)
    p = 0
    for y in range(h):
        ft = raw[p]
        p += 1
        line = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=p).astype(np.int32)
        p += stride
        if ft == 0:
            cur = line
        elif ft == 2:  # Up
            cur = (line + prev) & 0xFF
        elif ft == 1:  # Sub
            cur = line.copy()
            for c in range(nch):
                cur[c::nch] = np.cumsum(cur[c::nch]) & 0xFF
        else:
            b = bytearray(line.astype(np.uint8).tobytes())
            pr = prev.astype(np.uint8).tobytes()
            if ft == 3:  # Average
                for i in range(stride):
                    a = b[i - nch] if i >= nch else 0
                    b[i] = (b[i] + ((a + pr[i]) >> 1)) & 0xFF
            elif ft == 4:  # Paeth
                for i in range(stride):
                    a = b[i - nch] if i >= nch else 0
                    bb = pr[i]
                    c = pr[i - nch] if i >= nch else 0
                    pa = abs(bb - c)
                    pb = abs(a - c)
                    pc = abs(a + bb - 2 * c)
                    pr_ = a if (pa <= pb and pa <= pc) else (bb if pb <= pc else c)
                    b[i] = (b[i] + pr_) & 0xFF
            else:
                raise ValueError("filter %d" % ft)
            cur = np.frombuffer(bytes(b), dtype=np.uint8).astype(np.int32)
        out[y] = cur.astype(np.uint8)
        prev = cur
    img = out.reshape(h, w, nch)[:, :, :3]
    return img


def tile_xy(lon, lat):
    x, y = lonlat_to_tile(lon, lat, Z)
    return int(math.floor(x)), int(math.floor(y))


def fetch_tile(x, y):
    fn = os.path.join(CACHE, "%d_%d_%d.png" % (Z, x, y))
    if os.path.exists(fn) and os.path.getsize(fn) > 1000:
        return open(fn, "rb").read()
    url = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png" % (Z, x, y)
    with urllib.request.urlopen(url, timeout=60) as r:
        d = r.read()
    open(fn, "wb").write(d)
    return d


def main():
    x0, y1 = tile_xy(LON0, LAT0)
    x1, y0 = tile_xy(LON1, LAT1)
    tx, ty = x1 - x0 + 1, y1 - y0 + 1
    print("tiles x %d..%d y %d..%d -> %dx%d = %d tiles" % (x0, x1, y0, y1, tx, ty, tx * ty))

    mosaic = np.zeros((ty * 256, tx * 256), dtype=np.float32)
    lock = threading.Lock()
    done = [0]

    def work(ix, iy):
        try:
            img = decode_png(fetch_tile(x0 + ix, y0 + iy)).astype(np.float32)
            el = img[:, :, 0] * 256.0 + img[:, :, 1] + img[:, :, 2] / 256.0 - 32768.0
            with lock:
                mosaic[iy * 256:(iy + 1) * 256, ix * 256:(ix + 1) * 256] = el
                done[0] += 1
                if done[0] % 25 == 0:
                    print("  decoded %d/%d" % (done[0], tx * ty), flush=True)
        except Exception as e:  # noqa
            print("  FAIL tile", ix, iy, e, flush=True)

    idx = [(ix, iy) for iy in range(ty) for ix in range(tx)]
    threads = []
    sem = threading.Semaphore(12)

    def run(a):
        with sem:
            work(*a)

    for a in idx:
        t = threading.Thread(target=run, args=(a,))
        t.start()
        threads.append(t)
        if len(threads) % 60 == 0:
            for t in threads[-60:]:
                t.join()
    for t in threads:
        t.join()

    # mosaic pixel -> lon/lat helpers (web mercator)
    n = 2 ** Z

    def px_to_lon(px):
        return (x0 * 256 + px) / (n * 256) * 360.0 - 180.0

    def px_to_lat(py):
        yy = (y0 * 256 + py) / (n * 256)
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy))))

    # box-average resample via integral image
    ii = np.zeros((mosaic.shape[0] + 1, mosaic.shape[1] + 1), dtype=np.float64)
    ii[1:, 1:] = mosaic.cumsum(0).cumsum(1)

    elev = np.zeros((NY, NX), dtype=np.float32)
    dlon = (LON1 - LON0) / NX
    dlat = (LAT1 - LAT0) / NY
    px_of_lon = np.array([(lonlat_to_tile(LON0 + (i + 0.5) * dlon, 44.0, Z)[0] - x0) * 256
                          for i in range(NX)])
    py_of_lat = np.array([(lonlat_to_tile(-124.0, LAT1 - (j + 0.5) * dlat, Z)[1] - y0) * 256
                          for j in range(NY)])
    half_x = max(1.0, (px_of_lon[1] - px_of_lon[0]) / 2)
    half_y = max(1.0, (py_of_lat[1] - py_of_lat[0]) / 2)
    for j in range(NY):
        ya = int(max(0, py_of_lat[j] - half_y))
        yb = int(min(mosaic.shape[0], max(ya + 1, py_of_lat[j] + half_y)))
        for i in range(NX):
            xa = int(max(0, px_of_lon[i] - half_x))
            xb = int(min(mosaic.shape[1], max(xa + 1, px_of_lon[i] + half_x)))
            s = ii[yb, xb] - ii[ya, xb] - ii[yb, xa] + ii[ya, xa]
            elev[j, i] = s / ((yb - ya) * (xb - xa))

    # piecewise-linear 8-bit scale: 1 m near sea level, coarse in the abyss
    segs = [(-4600, -500, 62), (-500, -100, 11), (-100, -0.5, 2.5),
            (-0.5, 49.5, 1.0), (49.5, 399.5, 10), (399.5, 2900, 95)]
    tbl, centres = [], []
    for lo, hi, step in segs:
        v = lo
        while v < hi - 1e-9:
            centres.append(v + step / 2)
            tbl.append(round(v + step / 2, 2))
            v += step
    tbl = np.array(tbl, dtype=np.float64)
    print("quantisation levels:", len(tbl))
    assert len(tbl) <= 256, len(tbl)
    tbl = np.concatenate([tbl, np.full(256 - len(tbl), tbl[-1])])
    idx = np.clip(np.searchsorted(centres, elev.ravel()), 0, len(centres) - 1)
    # snap to the nearest centre rather than the containing band
    lo_i = np.clip(idx - 1, 0, len(centres) - 1)
    pick_left = np.abs(elev.ravel() - np.array(centres)[lo_i]) < np.abs(elev.ravel() - np.array(centres)[idx])
    idx = np.where(pick_left, lo_i, idx)
    q = idx.astype(np.uint8).reshape(elev.shape)
    dec = tbl[q]
    err = np.abs(dec - elev)
    print("quantisation error: mean %.2f m  p99 %.2f m  max %.2f m" %
          (err.mean(), np.percentile(err, 99), err.max()))
    for lim in (1, 3, 10, 30):
        print("  land below %2d m: %6d cells (%.0f km2)" %
              (lim, int(((elev >= 0) & (elev < lim)).sum()),
               ((elev >= 0) & (elev < lim)).sum() * 0.32))
    raw = q.tobytes()
    comp = zlib.compress(raw, 9)
    print("elev range %.0f..%.0f  raw %dKB gzip %dKB" %
          (elev.min(), elev.max(), len(raw) // 1024, len(comp) // 1024))
    ocean = (elev < 0).mean()
    print("ocean fraction %.3f" % ocean)
    print("bathy at (-125.5,44.5) ~ %.0f m" % float(np.interp(-125.5, np.linspace(LON0, LON1, NX),
          elev[int((LAT1 - 44.5) / (LAT1 - LAT0) * NY)])))
    for name, lo, la in [("Seaside", -123.92, 45.99), ("Astoria", -123.83, 46.19),
                         ("Newport", -124.05, 44.64), ("Coos Bay", -124.22, 43.37),
                         ("Brookings", -124.28, 42.05), ("Portland", -122.68, 45.52)]:
        i = int((lo - LON0) / dlon)
        j = int((LAT1 - la) / dlat)
        print("  %-9s elev %.0f m" % (name, elev[j, i]))

    json.dump({"lon0": LON0, "lat0": LAT0, "dlon": dlon, "dlat": dlat, "nx": NX, "ny": NY,
               "tbl": [round(float(v), 2) for v in tbl],
               "elev": base64.b64encode(comp).decode("ascii")},
              open(os.path.join(OUT, "dem.json"), "w"))
    print("wrote data/dem.json", os.path.getsize(os.path.join(OUT, "dem.json")) // 1024, "KB")


if __name__ == "__main__":
    main()
