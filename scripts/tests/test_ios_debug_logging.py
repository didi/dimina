from pathlib import Path
import selectors
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
LOGGER = ROOT / "iOS/dimina/DiminaKit/Utils/DMPLogger.swift"


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Requires Apple Swift")
class IOSDebugLoggingTests(unittest.TestCase):
    def test_large_bridge_logs_leave_main_queue_free_to_reply(self):
        # Run the real logger in its own process so stdout capture cannot affect
        # other tests. Hold the console reader until the bridge deadline finishes;
        # socket flow control models CI output backpressure without timed sleeps.
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            harness = directory / "main.swift"
            harness.write_text("""import Foundation
import Dispatch
let payload = "canvasCapabilities: " + String(repeating: "Canvas能力 ", count: 8192)
let reply = DispatchSemaphore(value: 0)
DispatchQueue.main.async {
    DMPLogger.debug(payload)
    DMPLogger.debug(payload)
    reply.signal()
}
DispatchQueue.global().async {
    let completed = reply.wait(timeout: .now() + 5) == .success
    FileHandle.standardError.write(Data("reply=\\(completed)\\n".utf8))
    exit(completed ? 0 : 1)
}
dispatchMain()
""")
            binary = directory / "logger-probe"
            subprocess.run(
                ["swiftc", "-D", "DEBUG", str(LOGGER), str(harness), "-o", str(binary)],
                check=True, capture_output=True, timeout=60,
            )
            reader, writer = socket.socketpair()
            writer.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16 * 1024)
            reader.settimeout(10)
            process = subprocess.Popen([str(binary)], stdout=writer, stderr=subprocess.PIPE)
            writer.close()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stderr, selectors.EVENT_READ)
                    self.assertTrue(selector.select(timeout=10), "Logger probe did not report its bridge result")
                result = process.stderr.readline()
                output = bytearray()
                while chunk := reader.recv(16 * 1024):
                    output.extend(chunk)
                process.wait(timeout=10)
                self.assertEqual(process.returncode, 0, result.decode())
                self.assertEqual(result, b"reply=true\n")
                self.assertGreater(len(output), 0, "The debug build must still emit diagnostics")
                self.assertLess(len(output), 16 * 1024, "Bridge payload logs must remain bounded")
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
                reader.close()


if __name__ == "__main__":
    unittest.main()
