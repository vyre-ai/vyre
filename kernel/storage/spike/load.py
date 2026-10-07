#!/usr/bin/env python3
"""Spike load driver: S3 put/get of random chunks against an endpoint, with timing. Usage: load.py ENDPOINT KEY SECRET BUCKET put N MB | get N | getmissing N"""
import sys, os, time, hashlib, random, concurrent.futures as cf, boto3
from botocore.config import Config
ep, key, sec, bucket, op = sys.argv[1:6]
s3 = boto3.client("s3", endpoint_url=ep, aws_access_key_id=key, aws_secret_access_key=sec, region_name=os.environ.get("REGION", "garage"),
                  config=Config(retries={"max_attempts": 1}, connect_timeout=5, read_timeout=30, s3={"addressing_style": "path"}, max_pool_connections=16))
def data(i, mb):
    r = random.Random(i); return r.randbytes(mb * 1024 * 1024)
def put(i, mb):
    try: s3.put_object(Bucket=bucket, Key=f"chunk/{i:05d}", Body=data(i, mb)); return True
    except Exception as e: return str(e)[:80]
def get(i, mb):
    try:
        b = s3.get_object(Bucket=bucket, Key=f"chunk/{i:05d}")["Body"].read()
        return hashlib.sha256(b).digest() == hashlib.sha256(data(i, mb)).digest() or "corrupt"
    except Exception as e: return str(e)[:80]
n = int(sys.argv[6]); mb = int(sys.argv[7]) if len(sys.argv) > 7 else 4
start = int(os.environ.get("START", "0"))
fn = put if op == "put" else get
t = time.time()
with cf.ThreadPoolExecutor(8) as ex: res = list(ex.map(lambda i: fn(i, mb), range(start, start + n)))
dt = time.time() - t
ok = sum(1 for r in res if r is True); errs = {}
for r in res:
    if r is not True: errs[r] = errs.get(r, 0) + 1
print(f"{op} n={n} mb={mb} ok={ok} fail={n-ok} secs={dt:.1f} MB/s={ok*mb/dt:.1f} errors={errs}")
