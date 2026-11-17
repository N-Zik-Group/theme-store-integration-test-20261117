"""Validate fork catalog data without checking out or executing fork code."""

import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile


DATA_ROOTS = ("catalog/themes/", "catalog/creators/")
DATA_SUFFIXES = {".json", ".jpg", ".png", ".webp", ".gif"}
CATALOG_LICENSE = "catalog/themes/LICENSE-GPL-3.0.txt"
FILE_LIMIT = 4 * 1024 * 1024
SNAPSHOT_LIMIT = 256 * 1024 * 1024


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root)


def revision(root, *args):
    return git(root, *args).decode("ascii").strip()


def candidate_tree(root, pull):
    number = pull["number"]
    base, head = pull["base"]["sha"], pull["head"]["sha"]
    if (type(number) is not int or number <= 0
            or not all(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha)
                       for sha in (base, head))):
        raise ValueError("Invalid pull request number or revisions")
    if revision(root, "rev-parse", "HEAD") != base:
        raise ValueError("The trusted checkout does not match the pull request base")
    git(root, "fetch", "--no-tags", "origin", f"refs/pull/{number}/head")
    if revision(root, "rev-parse", "FETCH_HEAD") != head:
        raise ValueError("The pull request head changed; retry the latest workflow run")
    tree = revision(root, "merge-tree", "--write-tree", base, head)
    if re.fullmatch(r"[0-9a-f]{40}", tree) is None:
        raise ValueError("Git did not produce a conflict-free merge candidate")
    return tree


def materialize(root, tree, destination):
    """Only catalog blobs cross the trust boundary; scripts/schemas/demo stay trusted."""
    destination = Path(destination)
    (destination / ".github/scripts").mkdir(parents=True)
    shutil.copyfile(root / ".github/scripts/validate_catalog.py",
                    destination / ".github/scripts/validate_catalog.py")
    shutil.copytree(root / "catalog/schemas", destination / "catalog/schemas")
    shutil.copytree(root / "demo", destination / "demo")
    for prefix in DATA_ROOTS:
        (destination / prefix).mkdir(parents=True)
    entries = git(root, "ls-tree", "-r", "-z", tree, "--", *DATA_ROOTS).split(b"\0")
    if len(entries) > 10001:
        raise ValueError("Catalog snapshot has too many files")
    total = 0
    for entry in filter(None, entries):
        metadata, filename = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split(" ")
        name = filename.decode("utf-8")
        parts = name.split("/")
        if (mode != "100644" or kind != "blob"
                or not name.startswith(DATA_ROOTS)
                or (name != CATALOG_LICENSE and re.fullmatch(r"[a-z0-9][a-z0-9._/-]*", name) is None)
                or any(part in {"", ".", ".."} for part in parts)
                or (name != CATALOG_LICENSE and PurePosixPath(name).suffix not in DATA_SUFFIXES)):
            raise ValueError(f"Expected a regular catalog data file: {name!r}")
        size = int(revision(root, "cat-file", "-s", oid))
        total += size
        if size > FILE_LIMIT or total > SNAPSHOT_LIMIT:
            raise ValueError("Catalog snapshot exceeds the validation size limit")
        output = destination.joinpath(*parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(git(root, "cat-file", "blob", oid))


def validate_pull_request(root, pull):
    tree = candidate_tree(root, pull)
    print("Validating merged catalog data with base-branch code, dependencies, schemas and demos.", flush=True)
    print("PR changes to executable code and schemas are not executed; push/manual checks test that code.", flush=True)
    with tempfile.TemporaryDirectory(prefix="nzik-pr-catalog-") as temporary:
        destination = Path(temporary)
        materialize(root, tree, destination)
        subprocess.run([sys.executable, "-I", "-B", str(destination / ".github/scripts/validate_catalog.py")],
                       cwd=destination, check=True)


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as event_file:
        event = json.load(event_file)
    validate_pull_request(root, {**event["pull_request"], "number": event["number"]})
