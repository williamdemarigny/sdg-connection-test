#!/usr/bin/env python3
"""Build the Windows easy-install bundle for the SDG Connection Test.

Produces: dist/sdg-connection-test-<version>-windows-x64.zip

The bundle wraps:
  - The tracked source tree at HEAD (extracted via `git archive`).
  - A pinned Node.js Windows runtime (node.exe only).
  - Run-Test.cmd launcher and README-FIRST.txt user guide from tools/.
  - A config.txt with TARGET_HOST set from --host.

Run from anywhere inside the repo:
  python tools/build-bundle.py --host 38.107.232.39

Optional flags:
  --version vX.Y.Z   Override version (default: `git describe --tags --abbrev=0`).
  --node-version vX.Y.Z   Override pinned Node version (default below).
  --output PATH      Override output zip path.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

# Pinned Node.js 22 LTS (Jod). Update both fields together when bumping.
# SHA256 is from https://nodejs.org/dist/<version>/SHASUMS256.txt
NODE_VERSION_DEFAULT = "v22.22.2"
NODE_WIN_X64_SHA256 = "7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c"

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = REPO_ROOT / "tools"
CACHE_DIR = TOOLS_DIR / "cache"
DIST_DIR = REPO_ROOT / "dist"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, cwd=REPO_ROOT, **kw)


def detect_version() -> str:
    try:
        r = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        )
        return r.stdout.strip()
    except subprocess.CalledProcessError:
        sys.exit("error: could not determine version from git tags; pass --version")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_node(node_version: str, expected_sha256: str) -> Path:
    """Download and SHA256-verify the Windows x64 Node zip. Cached."""
    fname = f"node-{node_version}-win-x64.zip"
    url = f"https://nodejs.org/dist/{node_version}/{fname}"
    out = CACHE_DIR / fname

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if out.exists():
        if sha256_file(out) == expected_sha256:
            print(f"[cache] {fname}")
            return out
        print(f"[cache] {fname} hash mismatch, re-downloading")
        out.unlink()

    print(f"[fetch] {url}")
    tmp = out.with_suffix(out.suffix + ".part")
    with urllib.request.urlopen(url) as resp, tmp.open("wb") as f:
        shutil.copyfileobj(resp, f)
    actual = sha256_file(tmp)
    if actual != expected_sha256:
        tmp.unlink()
        sys.exit(
            f"error: SHA256 mismatch for {fname}\n"
            f"  expected: {expected_sha256}\n"
            f"  got:      {actual}"
        )
    tmp.rename(out)
    return out


def extract_node_exe(node_zip: Path, dest_dir: Path, node_version: str) -> None:
    """Pull just node.exe and the upstream LICENSE file out of the Node zip."""
    inner_root = f"node-{node_version}-win-x64"
    dest_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(node_zip) as z:
        node_member = f"{inner_root}/node.exe"
        license_member = f"{inner_root}/LICENSE"
        with z.open(node_member) as src, (dest_dir / "node.exe").open("wb") as dst:
            shutil.copyfileobj(src, dst)
        with z.open(license_member) as src, (dest_dir / "LICENSE-node.txt").open("wb") as dst:
            shutil.copyfileobj(src, dst)


def stage_repo(stage_root: Path, from_worktree: bool) -> None:
    """Stage tracked files into stage_root.

    Default uses `git archive HEAD` so release builds are reproducible
    from the commit alone. Pass from_worktree=True during development
    to include uncommitted edits to tracked files.
    """
    stage_root.mkdir(parents=True, exist_ok=True)
    if from_worktree:
        r = subprocess.run(
            ["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        )
        for rel in r.stdout.splitlines():
            if not rel:
                continue
            src = REPO_ROOT / rel
            dst = stage_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        return
    archive_zip = stage_root.parent / "_repo.zip"
    if archive_zip.exists():
        archive_zip.unlink()
    run(["git", "archive", "--format=zip", "-o", str(archive_zip), "HEAD"])
    with zipfile.ZipFile(archive_zip) as z:
        z.extractall(stage_root)
    archive_zip.unlink()


def write_config(stage_root: Path, target_host: str) -> None:
    config = stage_root / "config.txt"
    config.write_text(
        "# SDG Connection Test - bundle configuration\n"
        "# Edit only if SDG support tells you to.\n"
        "#\n"
        "# TARGET_HOST: the IP (or hostname) of the SDG test server the\n"
        "# launcher should probe. Space Engineers does not resolve DNS,\n"
        "# so this is normally a literal IPv4 address.\n"
        f"TARGET_HOST={target_host}\n",
        encoding="utf-8",
        newline="\r\n",
    )


def write_top_files(stage_root: Path) -> None:
    shutil.copy2(TOOLS_DIR / "Run-Test.cmd", stage_root / "Run-Test.cmd")
    shutil.copy2(TOOLS_DIR / "README-FIRST.txt", stage_root / "README-FIRST.txt")


def make_zip(stage_parent: Path, top_dir_name: str, out_zip: Path) -> None:
    """Zip stage_parent/<top_dir_name> as <top_dir_name>/... entries.

    Uses forward-slash entries (Python zipfile default) so unzip and other
    standards-compliant tools handle it cleanly across platforms.
    """
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    if out_zip.exists():
        out_zip.unlink()

    src_root = stage_parent / top_dir_name
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(src_root.rglob("*")):
            if path.is_dir():
                continue
            arc = path.relative_to(stage_parent).as_posix()
            z.write(path, arc)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", required=True,
                    help="Target server IP or hostname baked into config.txt")
    ap.add_argument("--version", default=None,
                    help="Bundle version, e.g. v1.1.0 (default: latest git tag)")
    ap.add_argument("--node-version", default=NODE_VERSION_DEFAULT,
                    help=f"Node.js version to bundle (default: {NODE_VERSION_DEFAULT})")
    ap.add_argument("--node-sha256", default=NODE_WIN_X64_SHA256,
                    help="Expected SHA256 of node-<ver>-win-x64.zip")
    ap.add_argument("--output", default=None, help="Override output zip path")
    ap.add_argument("--keep-stage", action="store_true",
                    help="Keep the staging dir after build (for debugging)")
    ap.add_argument("--worktree", action="store_true",
                    help="Stage tracked files from the working tree instead of "
                         "git archive HEAD (use during development)")
    args = ap.parse_args()

    version = args.version or detect_version()
    if not version.startswith("v"):
        version = "v" + version

    out_zip = Path(args.output) if args.output else (
        DIST_DIR / f"sdg-connection-test-{version}-windows-x64.zip"
    )

    stage_parent = DIST_DIR / "_stage"
    if stage_parent.exists():
        shutil.rmtree(stage_parent)
    top_dir_name = "sdg-connection-test"
    stage_root = stage_parent / top_dir_name

    print(f"[build] version      : {version}")
    print(f"[build] target host  : {args.host}")
    print(f"[build] node version : {args.node_version}")
    print(f"[build] output       : {out_zip}")

    node_zip = download_node(args.node_version, args.node_sha256)
    stage_repo(stage_root, from_worktree=args.worktree)
    extract_node_exe(node_zip, stage_root / "runtime", args.node_version)
    write_config(stage_root, args.host)
    write_top_files(stage_root)
    make_zip(stage_parent, top_dir_name, out_zip)

    if not args.keep_stage:
        shutil.rmtree(stage_parent)

    digest = sha256_file(out_zip)
    size = out_zip.stat().st_size
    print()
    print(f"[done] {out_zip}")
    print(f"       size   : {size:,} bytes ({size / 1024 / 1024:.1f} MiB)")
    print(f"       sha256 : {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
