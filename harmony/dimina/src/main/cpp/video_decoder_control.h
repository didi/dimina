#pragma once

#include <atomic>
#include <cstdint>
#include <stdexcept>

class VideoDecoderStartGate {
public:
    uint64_t Capture() const { return generation.load(); }
    void Cancel() { generation.fetch_add(1); }
    void CheckCurrent(uint64_t token) const {
        if (token != Capture()) throw std::runtime_error("start cancelled by stop");
    }

private:
    std::atomic<uint64_t> generation {0};
};
