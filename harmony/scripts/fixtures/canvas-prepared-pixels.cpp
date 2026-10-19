#include "canvas_prepared_pixels.h"
#include <algorithm>
#include <cassert>
#include <iostream>
#include <random>
#include <thread>
using namespace dimina::canvas;
int main() {
    std::mt19937 random(352);
    for (size_t words : {size_t(0), size_t(1), size_t(2), size_t(3), size_t(127), size_t(128), size_t(129), size_t(8192), size_t(16384)}) {
        for (int kind = 0; kind < 4; kind++) {
            std::vector<uint8_t> input(words * 4);
            uint32_t word = 0;
            for (size_t index = 0; index < words; index++) {
                if (kind == 0 || (kind == 1 && index % 3 == 0) || (kind == 2 && index % 127 == 0)) word = random();
                std::memcpy(input.data() + index * 4, &word, 4);
            }
            auto packed = encodeCanvasRle32(input.data(), input.size());
            assert(MatchesCanvasRle32(input.data(), input.size(), packed));
            for (size_t offset = 0; offset < input.size(); offset += std::max(size_t(1), input.size() / 97)) {
                input[offset] ^= 1;
                assert(!MatchesCanvasRle32(input.data(), input.size(), packed));
                input[offset] ^= 1;
            }
            if (!packed.empty()) {
                packed.pop_back(); assert(!MatchesCanvasRle32(input.data(), input.size(), packed));
            }
        }
    }
    std::vector<uint8_t> bytes(65536, 1);
    auto prepared = PrepareCanvasPixels(bytes.data(), bytes.size());
    assert(prepared && prepared->packed.capacity() < bytes.size());
    assert(!MatchesCanvasRle32(nullptr, bytes.size(), prepared->packed));
    assert(!MatchesCanvasRle32(bytes.data(), bytes.size() - 1, prepared->packed));
    assert(!MatchesCanvasRle32(bytes.data(), bytes.size(), {0,0,0,0}));
    assert(!MatchesCanvasRle32(bytes.data(), bytes.size(), {255,255,255,255,1,1,1,1}));
    PreparedCanvasRegistry::Add(bytes.data(), prepared);
    assert(PreparedCanvasRegistry::Find(bytes.data(), bytes.size()));
    prepared.reset();
    assert(!PreparedCanvasRegistry::Find(bytes.data(), bytes.size()));
    prepared = PrepareCanvasPixels(bytes.data(), bytes.size());
    PreparedCanvasRegistry::Add(bytes.data(), prepared);
    assert(PreparedCanvasRegistry::Find(bytes.data(), bytes.size()));
    PreparedCanvasRegistry::Remove(bytes.data());
    std::vector<std::vector<uint8_t>> buffers(33, bytes);
    for (auto &buffer : buffers) PreparedCanvasRegistry::Add(buffer.data(), prepared);
    assert(PreparedCanvasRegistry::Find(buffers[0].data(), bytes.size()));
    assert(!PreparedCanvasRegistry::Find(buffers[32].data(), bytes.size()));
    for (auto &buffer : buffers) PreparedCanvasRegistry::Remove(buffer.data());
    std::vector<std::thread> threads;
    for (int index = 0; index < 4; index++) threads.emplace_back([&] {
        auto input = bytes;
        for (int turn = 0; turn < 1000; turn++) {
            PreparedCanvasRegistry::Add(input.data(), prepared);
            assert(PreparedCanvasRegistry::Find(input.data(), input.size()));
            PreparedCanvasRegistry::Remove(input.data());
        }
    });
    for (auto &thread : threads) thread.join();
    std::cout << "PASS exact runs/literals, mutations, malformed packets, weak lifetimes, cache bound, threads\n";
}
