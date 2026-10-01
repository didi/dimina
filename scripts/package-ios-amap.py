#!/usr/bin/env python3
"""Build the optional, self-contained Swift package. Never uploads artifacts."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def package(version, output, cache):
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("version must be the core SDK's release version, without v")
    destination = output / f"DiminaMapAMap-{version}"
    archive = output / f"DiminaMapAMap-{version}.zip"
    if destination.exists() or archive.exists():
        raise FileExistsError(f"Output already exists: {destination} / {archive}")
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    vendors = json.loads((ROOT / "iOS/MapAMap/vendor.json").read_text())
    with tempfile.TemporaryDirectory(prefix="dimina-map-package-") as temp:
        work = Path(temp)
        package_root = work / destination.name
        frameworks = package_root / "Frameworks"
        frameworks.mkdir(parents=True)
        for name, vendor in vendors.items():
            download = cache / f"{name}-{vendor['version']}.zip"
            if not download.exists():
                partial = download.with_suffix(".download")
                run("curl", "--fail", "--location", "--retry", "3", vendor["url"], "-o", partial)
                partial.rename(download)
            if hashlib.sha256(download.read_bytes()).hexdigest() != vendor["sha256"]:
                raise ValueError(f"Checksum mismatch: {download}")
            extracted = work / name
            with zipfile.ZipFile(download) as sdk:
                sdk.extractall(extracted)
            original = extracted / f"{name}.framework"
            if name == "MAMapKit":
                resources = package_root / "Resources"
                resources.mkdir()
                shutil.copytree(original / "AMap.bundle", resources / "AMap.bundle")
            # Official fat archives contain arm64 device + x86_64 simulator, not arm64 simulator.
            slices = []
            for arch, platform in [("arm64", "iPhoneOS"), ("x86_64", "iPhoneSimulator")]:
                framework = work / f"{name}-{arch}" / original.name
                shutil.copytree(original, framework)
                run("xcrun", "lipo", original / name, "-thin", arch, "-output", framework / name)
                info_path = framework / "Info.plist"
                with info_path.open("rb") as stream:
                    info = plistlib.load(stream)
                info["CFBundleSupportedPlatforms"] = [platform]
                info["DTPlatformName"] = platform.lower()
                with info_path.open("wb") as stream:
                    plistlib.dump(info, stream)
                shutil.rmtree(framework / "_CodeSignature", ignore_errors=True)
                slices.extend(["-framework", framework])
            run("xcodebuild", "-create-xcframework", *slices, "-output", frameworks / f"{name}.xcframework")

        # Reuse the main package graph, including the core sources. Depending on the
        # remote Dimina package would declare all three map targets a second time.
        manifest = (ROOT / "Package.swift").read_text()
        for name in vendors:
            pattern = (
                r'(\.binaryTarget\(\s*name: "' + re.escape(name)
                + r'",)\s*url: "[^"]+",\s*checksum: "[^"]+"'
            )
            manifest, count = re.subn(
                pattern,
                rf'\1\n            path: "Frameworks/{name}.xcframework"',
                manifest,
            )
            if count != 1:
                raise ValueError(f"Expected one remote binary target for {name}")
        (package_root / "Package.swift").write_text(manifest)
        shutil.copytree(ROOT / "iOS/dimina", package_root / "iOS/dimina",
                        ignore=shutil.ignore_patterns(".DS_Store"))
        # The manifest's native targets and their relative includes must remain
        # inside the standalone package, along with the upstream license files.
        for relative in ("third_party/wamr", "native/wasm"):
            shutil.copytree(ROOT / relative, package_root / relative,
                            ignore=shutil.ignore_patterns(".DS_Store", ".build", ".swiftpm"))
        shutil.copy(ROOT / "iOS/MapAMap/README.md", package_root / "README.md")
        shutil.copy(ROOT / "LICENSE", package_root / "LICENSE")
        shutil.copy(ROOT / "iOS/MapAMap/vendor.json", package_root / "vendor.json")
        (package_root / "NOTICE").write_text(
            "Dimina adapter source: Apache-2.0. WAMR: Apache-2.0 WITH LLVM-exception;\n"
            "see third_party/wamr/LICENSE and third_party/wamr/ATTRIBUTIONS.md.\n"
            "Bundled AMap SDK binaries and resources:\n"
            "Copyright AutoNavi. All Rights Reserved. https://lbs.amap.com/\n"
        )
        shutil.copytree(package_root, destination)
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", destination, archive)
    # Also publish XCFramework assets for the main repository's optional SwiftPM product.
    for name, vendor in vendors.items():
        binary_archive = output / f"{name}-{vendor['version']}.xcframework.zip"
        if binary_archive.exists():
            raise FileExistsError(binary_archive)
        run("ditto", "-c", "-k", "--keepParent", destination / "Frameworks" / f"{name}.xcframework", binary_archive)
    print(archive)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "dimina-amap-downloads")
    args = parser.parse_args()
    package(args.version, args.output.resolve(), args.cache.resolve())
