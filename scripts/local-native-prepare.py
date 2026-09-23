"""Extract verified build inputs safely and compile inside the offline container."""

import hashlib
import json
import shutil
import stat
import subprocess
import zipfile
from pathlib import Path, PurePosixPath


def extract(archive, destination, expected_hash, prefix=None):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_hash:
        raise ValueError(f"Archive hash mismatch: {archive}")
    destination.mkdir(parents=True, exist_ok=False)
    root = destination.resolve()
    with zipfile.ZipFile(archive) as source:
        members = []
        seen = set()
        for info in source.infolist():
            name = info.filename
            parts = PurePosixPath(name).parts
            mode = info.external_attr >> 16
            if (not parts or name.startswith("/") or "\\" in name or ":" in name
                    or ".." in parts or stat.S_ISLNK(mode)
                    or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError(f"Unsafe ZIP member: {name}")
            if prefix:
                if parts[0] != prefix:
                    raise ValueError(f"Unexpected archive prefix: {name}")
                parts = parts[1:]
            if not parts:
                if info.is_dir():
                    continue
                raise ValueError(f"Invalid ZIP root: {name}")
            target = root.joinpath(*parts).resolve()
            if not target.is_relative_to(root) or target in seen:
                raise ValueError(f"Unsafe or duplicate ZIP target: {name}")
            seen.add(target)
            members.append((info, target))
        # Validate every entry before writing any archive content.
        for info, target in members:
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(info) as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst)


def main():
    work = Path("/work")
    plan = json.loads((work / "build-plan.json").read_text())
    for archive in plan["archives"]:
        extract(work / "archives" / archive["name"], work / archive["destination"],
                archive["sha256"], archive.get("prefix"))
    for command in plan["commands"]:
        subprocess.run(command, check=True, cwd=work)


if __name__ == "__main__":
    main()
