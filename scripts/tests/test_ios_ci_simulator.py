import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/ios-tests.yml").read_text()


def workflow_ruby(flags, filename):
    match = re.search(
        rf"ruby {flags}-e '(.*?)'\s+\"\$RUNNER_TEMP/{filename}\"",
        WORKFLOW,
        re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"Missing simulator selector for {filename}")
    return match.group(1)


class IOSCISimulatorTests(unittest.TestCase):
    def run_selector(self, script, fixture, sdk="26.5"):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            path.write_text(fixture)
            result = subprocess.run(
                ["ruby", "-rjson", "-e", script, str(path), sdk],
                check=True,
                capture_output=True,
                text=True,
            )
        return result.stdout.strip()

    @staticmethod
    def device(version, number):
        return (
            "{ platform:iOS Simulator, arch:arm64, "
            f"id:00000000-0000-0000-0000-{number:012d}, "
            f"OS:{version}, name:iPhone 17 }}"
        )

    @staticmethod
    def runtime(version, available=True):
        return {
            "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-" + version.replace(".", "-"),
            "version": version,
            "isAvailable": available,
            "supportedDeviceTypes": [
                {"productFamily": "iPhone", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17"}
            ],
        }

    def test_destinations_match_sdk_and_accept_patch_releases(self):
        script = workflow_ruby("", r"dimina-destinations\.txt")
        fixture = "\n".join([
            self.device("26.2", 1),
            self.device("26.5", 2),
            self.device("26.5.1", 3),
            self.device("27.0", 4),
            "Ineligible destinations for the scheme:",
            self.device("26.5.2", 5),
        ])
        self.assertEqual(self.run_selector(script, fixture), "00000000-0000-0000-0000-000000000003")

    def test_destinations_do_not_fall_back_to_an_older_runtime(self):
        script = workflow_ruby("", r"dimina-destinations\.txt")
        self.assertEqual(self.run_selector(script, self.device("26.2", 1)), "")

    def test_creation_uses_available_matching_runtime(self):
        script = workflow_ruby("-rjson ", r"dimina-runtimes\.json")
        fixture = json.dumps({"runtimes": [
            self.runtime("26.2"), self.runtime("26.5"), self.runtime("26.5.1"),
            self.runtime("26.5.2", available=False), self.runtime("27.0"),
        ]})
        self.assertEqual(
            self.run_selector(script, fixture),
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5-1 com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        )

    def test_creation_does_not_fall_back_to_an_older_runtime(self):
        script = workflow_ruby("-rjson ", r"dimina-runtimes\.json")
        fixture = json.dumps({"runtimes": [self.runtime("26.2")]})
        self.assertEqual(self.run_selector(script, fixture), "")


if __name__ == "__main__":
    unittest.main()
