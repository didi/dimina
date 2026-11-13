#!/usr/bin/env python3
"""Prepare desktop release versions and artifacts. Does not upload anything."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLATFORMS = tuple(f"{system}/{arch}" for system in ("darwin", "windows", "linux") for arch in ("amd64", "arm64"))
NUMBER = r"(?:0|[1-9][0-9]*)"
IDENTIFIER = rf"(?:{NUMBER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
TAG = re.compile(rf"v({NUMBER}\.{NUMBER}\.{NUMBER}(?:-{IDENTIFIER}(?:\.{IDENTIFIER})*)?)")


def version_from_tag(tag):
    match = TAG.fullmatch(tag)
    if not match:
        raise ValueError("Expected a release tag such as v1.2.3 or v1.2.3-beta.1; build metadata is not supported")
    return match[1]


def replace_once(path, pattern, replacement):
    text, count = re.subn(pattern, replacement, path.read_text(encoding="utf-8"), count=1, flags=re.M)
    if count != 1:
        raise ValueError(f"Version field not found: {path}")
    path.write_text(text, encoding="utf-8")


def prepare(root, tag):
    version = version_from_tag(tag)
    sdk = root / "desktop/sdk"
    for path in (root / "desktop/mygo.json", sdk / "node/package.json"):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["version"] = version
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    replace_once(sdk / "tauri/Cargo.toml", r'^version = "[^"]+"$', f'version = "{version}"')
    replace_once(sdk / "dotnet/Dimina.Desktop.csproj", r"<Version>[^<]+</Version>", f"<Version>{version}</Version>")
    # CMake's project(VERSION) accepts numeric components only.
    replace_once(sdk / "qt/CMakeLists.txt", r"(?<=project\(DiminaDesktopSDK VERSION )[0-9.]+", version.split("-")[0])
    return version


def copy_entry(source, destination):
    if source.is_dir() and not source.is_symlink():
        shutil.copytree(source, destination, symlinks=True)
    else:
        shutil.copy2(source, destination, follow_symlinks=False)


def bundle(root, tag, platform, output):
    version = version_from_tag(tag)
    if platform not in PLATFORMS:
        raise ValueError(f"Unsupported release platform: {platform}")
    sdk = root / "desktop/sdk/dist"
    platform_name = platform.replace("/", "-")
    runtime = sdk / "runtime" / platform_name
    name = f"dimina-desktop-sdk-{version}-{platform_name}"
    extension = ".zip" if platform.startswith("windows/") else ".tar.gz"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / (name + extension)
    if archive.exists():
        raise FileExistsError(archive)
    metadata = json.loads((sdk / "version.json").read_text(encoding="utf-8"))
    if metadata != {"version": version, "platform": platform}:
        raise ValueError("SDK build version/platform does not match this release")
    executable = {
        "darwin": "Dimina Desktop.app/Contents/MacOS/Dimina Desktop",
        "windows": "Dimina Desktop.exe",
        "linux": "dimina-desktop",
    }[platform.split("/")[0]]
    helper = "Dimina Desktop.app/Contents/Resources/dimina-device-bridge" if platform.startswith("darwin/") else "dimina-device-bridge" + (".exe" if platform.startswith("windows/") else "")
    for file in (executable, helper):
        if not (runtime / file).is_file():
            raise FileNotFoundError(runtime / file)
    with tempfile.TemporaryDirectory(prefix="dimina-sdk-release-") as directory:
        stage = Path(directory) / name
        stage.mkdir()
        for entry in ("node", "qt", "dotnet", "tauri", "licenses", "LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "Native-APIs.md", "version.json"):
            copy_entry(sdk / entry, stage / entry)
        destination = stage / "runtime" / platform_name
        destination.mkdir(parents=True)
        if platform.startswith("darwin/"):
            entries = ["Dimina Desktop.app"]
        else:
            # MyGo also emits installers/archives. Ship only its installed file set.
            entries = (runtime / ".mygo-files").read_text(encoding="utf-8").splitlines()
            if not entries or executable not in entries or helper not in entries:
                raise ValueError("Incomplete runtime file manifest")
            if any(not entry or entry in (".", "..", ".mygo-files") or re.search(r"[/\\\x00]", entry) for entry in entries):
                raise ValueError("Invalid runtime file manifest")
            entries.append(".mygo-files")
        for entry in entries:
            copy_entry(runtime / entry, destination / entry)
        if extension == ".zip":
            shutil.make_archive(str(output / name), "zip", directory, name)
        else:
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(stage, arcname=name)
    return archive


def cargo_metadata(root, tag, output):
    version = version_from_tag(tag)
    manifest = root / "desktop/sdk/tauri/Cargo.toml"
    result = subprocess.run(["cargo", "metadata", "--no-deps", "--format-version=1", "--manifest-path", str(manifest)], check=True, capture_output=True, text=True)
    package = next(pkg for pkg in json.loads(result.stdout)["packages"] if pkg["name"] == "tauri-plugin-dimina")
    if package["version"] != version:
        raise ValueError("Cargo package version does not match release tag")
    metadata = {key: package.get(key) for key in ("name", "description", "documentation", "homepage", "keywords", "categories", "license", "license_file", "repository", "links", "rust_version")}
    metadata.update(vers=version, authors=package["authors"], features=package["features"], readme=(manifest.parent / package["readme"]).read_text(encoding="utf-8"), readme_file=package["readme"])
    # crates.io renders this README outside the repository directory structure.
    for file in ("README.md", "Native-APIs.md"):
        metadata["readme"] = metadata["readme"].replace(f"](../{file}", f"](https://github.com/didi/dimina/blob/{tag}/desktop/sdk/{file}")
    metadata["deps"] = [dict(name=dep["name"], version_req=dep["req"], features=dep["features"], optional=dep["optional"], default_features=dep["uses_default_features"], target=dep["target"], kind=dep["kind"] or "normal", registry=dep["registry"], explicit_name_in_toml=dep["rename"]) for dep in package["dependencies"]]
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"tauri-plugin-dimina-{version}.metadata.json"
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def checksums(tag, directory):
    version = version_from_tag(tag)
    expected = {f"dimina-desktop-sdk-{version}-{platform.replace('/', '-')}{'.zip' if platform.startswith('windows/') else '.tar.gz'}" for platform in PLATFORMS}
    expected.update((f"dimina-desktop-sdk-{version}.tgz", f"tauri-plugin-dimina-{version}.crate", f"tauri-plugin-dimina-{version}.metadata.json", f"Dimina.Desktop.{version}.nupkg"))
    actual = {path.name for path in directory.iterdir() if path.name != "SHA256SUMS-desktop.txt"}
    if actual != expected:
        raise ValueError(f"Unexpected artifact set; missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    lines = []
    for name in sorted(expected):
        path = directory / name
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Empty or missing artifact: {name}")
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {name}\n")
    path = directory / "SHA256SUMS-desktop.txt"
    path.write_text("".join(lines), encoding="utf-8")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "bundle", "cargo-metadata", "checksums"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--platform", choices=PLATFORMS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    version = version_from_tag(args.tag)
    if args.command == "prepare":
        def revision(ref):
            return subprocess.check_output(["git", "rev-parse", "--verify", ref], cwd=ROOT, text=True).strip()
        if revision("HEAD") != revision(f"refs/tags/{args.tag}^{{commit}}"):
            raise ValueError("Checkout must match the release tag")
        prepare(ROOT, args.tag)
        if args.github_output:
            with args.github_output.open("a", encoding="utf-8") as stream:
                stream.write(f"version={version}\nnpm_tag={'next' if '-' in version else 'latest'}\nprerelease={str('-' in version).lower()}\n")
        print(f"Prepared desktop release {version}")
    elif args.command == "bundle":
        if not args.output or not args.platform:
            parser.error("bundle requires --platform and --output")
        print(bundle(ROOT, args.tag, args.platform, args.output.resolve()))
    elif args.command == "cargo-metadata":
        if not args.output:
            parser.error("cargo-metadata requires --output")
        print(cargo_metadata(ROOT, args.tag, args.output))
    else:
        if not args.directory:
            parser.error("checksums requires --directory")
        print(checksums(args.tag, args.directory))


if __name__ == "__main__":
    main()
