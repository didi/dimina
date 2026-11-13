import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("desktop_release", Path(__file__).resolve().parents[1] / "release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sdk = self.root / "desktop/sdk"

    def write(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_release_tags_reject_paths_shell_fragments_and_non_semver(self):
        for tag in ("v1.2.3", "v0.1.0-beta.1", "v1.2.3-rc"):
            self.assertEqual(release.version_from_tag(tag), tag[1:])
        for tag in ("1.2.3", "v01.2.3", "v1.2.3-01", "v1.2.3+local", "v1.2.3/other", "v1.2.3\n", "v1.2.3;echo bad", "v1.2.3-", "v1.2.3-beta..1"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.version_from_tag(tag)

    def test_prepare_versions_keeps_prerelease_but_uses_numeric_cmake_version(self):
        self.write(self.root / "desktop/mygo.json", '{"version":"0.1.0","name":"Dimina Desktop"}')
        self.write(self.sdk / "node/package.json", '{"version":"0.1.0","name":"@dimina/desktop-sdk"}')
        self.write(self.sdk / "tauri/Cargo.toml", '[package]\nversion = "0.1.0"\n[dependencies]\nfoo = "1"\n')
        self.write(self.sdk / "dotnet/Dimina.Desktop.csproj", '<Project><Version>0.1.0</Version></Project>')
        self.write(self.sdk / "qt/CMakeLists.txt", 'project(DiminaDesktopSDK VERSION 0.1.0 LANGUAGES CXX)')
        release.prepare(self.root, "v1.9.0-beta.1")
        self.assertEqual(json.loads((self.sdk / "node/package.json").read_text())["version"], "1.9.0-beta.1")
        self.assertIn('version = "1.9.0-beta.1"', (self.sdk / "tauri/Cargo.toml").read_text())
        self.assertIn('<Version>1.9.0-beta.1</Version>', (self.sdk / "dotnet/Dimina.Desktop.csproj").read_text())
        self.assertIn('VERSION 1.9.0 LANGUAGES', (self.sdk / "qt/CMakeLists.txt").read_text())

    def fixture_bundle(self, platform):
        dist = self.sdk / "dist"
        for directory in ("node", "qt", "dotnet", "tauri", "licenses"):
            self.write(dist / directory / "keep", "library or license")
        for file in ("LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "Native-APIs.md"):
            self.write(dist / file, "documentation")
        self.write(dist / "version.json", json.dumps(dict(version="1.9.0", platform=platform)))
        runtime = dist / "runtime" / platform.replace("/", "-")
        if platform.startswith("darwin/"):
            executable = runtime / "Dimina Desktop.app/Contents/MacOS/Dimina Desktop"
            helper = runtime / "Dimina Desktop.app/Contents/Resources/dimina-device-bridge"
        else:
            executable = runtime / ("Dimina Desktop.exe" if platform.startswith("windows/") else "dimina-desktop")
            helper = runtime / ("dimina-device-bridge.exe" if platform.startswith("windows/") else "dimina-device-bridge")
            self.write(runtime / ".mygo-files", f"{executable.name}\n{helper.name}\n")
        for file in (executable, helper):
            self.write(file, "executable")
            file.chmod(0o755)
        self.write(runtime / "unwanted-duplicate.tar.gz", "not installed")
        return runtime, executable

    def test_unix_bundle_preserves_app_structure_executable_permissions_and_symlinks(self):
        runtime, executable = self.fixture_bundle("darwin/arm64")
        (runtime / "Dimina Desktop.app/Contents/Resources/helper-link").symlink_to("dimina-device-bridge")
        archive = release.bundle(self.root, "v1.9.0", "darwin/arm64", self.root / "out")
        with tarfile.open(archive) as tar:
            prefix = "dimina-desktop-sdk-1.9.0-darwin-arm64/runtime/darwin-arm64/"
            self.assertEqual(tar.getmember(prefix + str(executable.relative_to(runtime))).mode & 0o111, 0o111)
            self.assertTrue(tar.getmember(prefix + "Dimina Desktop.app/Contents/Resources/helper-link").issym())
            self.assertFalse(any("unwanted" in name for name in tar.getnames()))

    def test_windows_bundle_uses_installed_files_and_does_not_nest_archives(self):
        self.fixture_bundle("windows/amd64")
        archive = release.bundle(self.root, "v1.9.0", "windows/amd64", self.root / "out")
        with zipfile.ZipFile(archive) as zipped:
            self.assertTrue(any(name.endswith("Dimina Desktop.exe") for name in zipped.namelist()))
            self.assertTrue(any(name.endswith(".mygo-files") for name in zipped.namelist()))
            self.assertFalse(any("unwanted" in name for name in zipped.namelist()))

    def test_bundle_rejects_missing_helper_mismatched_build_and_manifest_traversal(self):
        runtime, _ = self.fixture_bundle("linux/amd64")
        helper = runtime / "dimina-device-bridge"
        helper.unlink()
        with self.assertRaises(FileNotFoundError):
            release.bundle(self.root, "v1.9.0", "linux/amd64", self.root / "out")
        self.write(helper, "helper")
        self.write(runtime / ".mygo-files", "dimina-desktop\ndimina-device-bridge\n../../outside\n")
        with self.assertRaisesRegex(ValueError, "Invalid runtime"):
            release.bundle(self.root, "v1.9.0", "linux/amd64", self.root / "out")
        with self.assertRaisesRegex(ValueError, "version/platform"):
            release.bundle(self.root, "v1.9.1", "linux/amd64", self.root / "out")

    def test_checksums_require_all_architectures_and_exact_release_versions(self):
        directory = self.root / "out"
        directory.mkdir()
        self.write(directory / "dimina-desktop-sdk-1.9.0.tgz", "npm")
        with self.assertRaisesRegex(ValueError, "missing="):
            release.checksums("v1.9.0", directory)
        for platform in release.PLATFORMS:
            extension = ".zip" if platform.startswith("windows/") else ".tar.gz"
            self.write(directory / f"dimina-desktop-sdk-1.9.0-{platform.replace('/', '-')}{extension}", "runtime")
        for name in ("tauri-plugin-dimina-1.9.0.crate", "tauri-plugin-dimina-1.9.0.metadata.json", "Dimina.Desktop.1.9.0.nupkg"):
            self.write(directory / name, "package")
        sums = release.checksums("v1.9.0", directory).read_text()
        self.assertIn(f"{hashlib.sha256(b'npm').hexdigest()}  dimina-desktop-sdk-1.9.0.tgz", sums)
        self.assertEqual(len(sums.splitlines()), 10)
        self.write(directory / "wrong-version.zip", "unrelated")
        with self.assertRaisesRegex(ValueError, "extra="):
            release.checksums("v1.9.0", directory)


if __name__ == "__main__":
    unittest.main()
