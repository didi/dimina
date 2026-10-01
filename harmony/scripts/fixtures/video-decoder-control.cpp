#include "video_decoder_control.h"
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <thread>

int main() {
    VideoDecoderStartGate gate;
    const auto oldStart = gate.Capture();
    bool sourcePending = false, sourceResolved = false, activated = false, rejected = false;
    std::mutex mutex;
    std::condition_variable ready;
    std::thread source([&] {
        {
            std::unique_lock<std::mutex> lock(mutex);
            sourcePending = true;
            ready.notify_all();
            ready.wait(lock, [&] { return sourceResolved; });
        }
        try { gate.CheckCurrent(oldStart); activated = true; }
        catch (const std::runtime_error &) { rejected = true; }
    });
    {
        std::unique_lock<std::mutex> lock(mutex);
        ready.wait(lock, [&] { return sourcePending; });
        gate.Cancel();
        sourceResolved = true;
        ready.notify_all();
    }
    source.join();
    if (!rejected || activated) {
        std::cerr << "A pre-stop asynchronous start must reject before activating a decoder\n";
        return 1;
    }
    const auto newStart = gate.Capture();
    gate.CheckCurrent(newStart);
    gate.Cancel();
    try {
        gate.CheckCurrent(newStart);
        std::cerr << "A stop during decoder configuration must reject the old start\n";
        return 1;
    } catch (const std::runtime_error &) {}
    gate.CheckCurrent(gate.Capture());
}
