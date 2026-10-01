"""Check the release archive's source closure without downloading vendor SDKs."""
import hashlib
import importlib.util
import io
from pathlib import Path
import plistlib
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("package_ios_amap", ROOT / "scripts/package-ios-amap.py")
PACKAGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGER)


class PackageSourcesTest(unittest.TestCase):
    def test_release_archive_contains_wasm_targets_relative_includes_and_licenses(self):
        with tempfile.TemporaryDirectory(prefix="dimina-map-package-test-") as temporary:
            work = Path(temporary)
            cache = work / "cache"
            cache.mkdir()
            vendors = {}
            for name in ("MAMapKit", "AMapFoundationKit"):
                archive_path = cache / f"{name}-fixture.zip"
                with zipfile.ZipFile(archive_path, "w") as archive:
                    archive.writestr(f"{name}.framework/{name}", b"vendor binary fixture")
                    archive.writestr(f"{name}.framework/Info.plist", plistlib.dumps({"CFBundleSupportedPlatforms": ["iPhoneOS"]}))
                    if name == "MAMapKit":
                        archive.writestr(f"{name}.framework/AMap.bundle/fixture.txt", "map resources")
                vendors[name] = {"version": "fixture", "url": "unused", "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest()}

            # Exercise the actual packager and archive layout. These adapters only
            # replace vendor slicing / XCFramework assembly, not a native build.
            def run(*arguments):
                args = [str(argument) for argument in arguments]
                if args[0] == "xcrun":
                    shutil.copy(args[2], args[args.index("-output") + 1])
                elif args[0] == "xcodebuild":
                    destination = Path(args[args.index("-output") + 1])
                    destination.mkdir()
                    (destination / "Info.plist").write_bytes(plistlib.dumps({"AvailableLibraries": []}))
                elif args[0] == "ditto":
                    source, destination = Path(args[-2]), Path(args[-1])
                    with zipfile.ZipFile(destination, "w") as archive:
                        for file in source.rglob("*"):
                            if file.is_file():
                                archive.write(file, Path(source.name) / file.relative_to(source))
                else:
                    self.fail(f"Unexpected external command: {args}")

            with patch.object(PACKAGER.json, "loads", return_value=vendors), patch.object(PACKAGER, "run", side_effect=run), patch("sys.stdout", new=io.StringIO()):
                PACKAGER.package("9.9.9", work / "output", cache)

            destination = work / "output/DiminaMapAMap-9.9.9"
            required = [
                "third_party/wamr/upstream/core/iwasm/common/wasm_c_api.c",
                "third_party/wamr/apple_bridge/dimina_wasm.cpp",
                "third_party/wamr/apple_bridge/include/dimina_wasm.h",
                "third_party/wamr/apple_helpers.c",
                "third_party/wamr/LICENSE",
                "third_party/wamr/ATTRIBUTIONS.md",
                "third_party/wamr/UPSTREAM_COMMIT",
                "native/wasm/dimina_wasm.cpp",
                "native/wasm/js_value.hpp",
                "native/wasm/include/dimina_wasm.h",
                "native/wasm/wamr_helpers.c",
            ]
            with zipfile.ZipFile(work / "output/DiminaMapAMap-9.9.9.zip") as archive:
                for relative in required:
                    self.assertTrue((destination / relative).is_file(), f"Missing SwiftPM source or license: {relative}")
                    self.assertEqual((ROOT / relative).read_bytes(), archive.read(f"{destination.name}/{relative}"))
            # Keep the bridge's relative include targets valid after extraction.
            for relative, include in [
                ("third_party/wamr/apple_bridge/dimina_wasm.cpp", "../../../native/wasm/dimina_wasm.cpp"),
                ("third_party/wamr/apple_bridge/include/dimina_wasm.h", "../../../../native/wasm/include/dimina_wasm.h"),
                ("third_party/wamr/apple_helpers.c", "../../native/wasm/wamr_helpers.c"),
            ]:
                self.assertTrue((destination / relative).parent.joinpath(include).is_file())
            self.assertIn("WAMR", (destination / "NOTICE").read_text())


if __name__ == "__main__":
    unittest.main()
