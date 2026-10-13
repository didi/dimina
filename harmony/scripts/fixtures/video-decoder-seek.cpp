#include "video_decoder_control.h"
#include "video_decoder_pixels.h"
#include "video_decoder_headers.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <exception>
#include <fcntl.h>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

using OH_AVErrCode = int;
constexpr int AV_ERR_OK = 0, AV_ERR_INVALID = 17, AV_ERR_SEEK = 23;
constexpr int AV_PIXEL_FORMAT_NV12 = 0, SEEK_MODE_PREVIOUS_SYNC = 0;
constexpr uint32_t AVCODEC_BUFFER_FLAGS_EOS = 1, AVCODEC_BUFFER_FLAGS_CODEC_DATA = 2;
constexpr uint32_t AVCODEC_BUFFER_FLAGS_SYNC_FRAME = 4;

#define AV_KEY(name) constexpr const char *name = #name
AV_KEY(OH_MD_KEY_TRACK_COUNT);
AV_KEY(OH_MD_KEY_CODEC_MIME);
AV_KEY(OH_MD_KEY_WIDTH);
AV_KEY(OH_MD_KEY_HEIGHT);
AV_KEY(OH_MD_KEY_VIDEO_PIC_WIDTH);
AV_KEY(OH_MD_KEY_VIDEO_PIC_HEIGHT);
AV_KEY(OH_MD_KEY_VIDEO_STRIDE);
AV_KEY(OH_MD_KEY_VIDEO_SLICE_HEIGHT);
AV_KEY(OH_MD_KEY_VIDEO_CROP_LEFT);
AV_KEY(OH_MD_KEY_VIDEO_CROP_TOP);
AV_KEY(OH_MD_KEY_PIXEL_FORMAT);
AV_KEY(OH_MD_KEY_RANGE_FLAG);
AV_KEY(OH_MD_KEY_COLOR_PRIMARIES);
AV_KEY(OH_MD_KEY_CODEC_CONFIG);
#undef AV_KEY

struct OH_AVCodec;
struct OH_AVMemory {
    std::vector<uint8_t> bytes {64, 64, 64, 64, 128, 128};
    OH_AVCodec *owner = nullptr;
    uint32_t index = 0;
    int generation = 0;
    bool consumed = false, freed = false, block = false, entered = false, sampleEos = false;
};
struct OH_AVCodecBufferAttr { int32_t offset = 0, size = 0; int64_t pts = 0; uint32_t flags = 0; };
struct OH_AVFormat { std::map<std::string, int32_t> values; std::string mime = "video/mock"; std::vector<uint8_t> config; };
struct OH_AVSource {};
struct OH_AVDemuxer {};
struct OH_AVCodecCallback {
    void (*error)(OH_AVCodec *, int32_t, void *);
    void (*format)(OH_AVCodec *, OH_AVFormat *, void *);
    void (*input)(OH_AVCodec *, uint32_t, OH_AVMemory *, void *);
    void (*output)(OH_AVCodec *, uint32_t, OH_AVMemory *, OH_AVCodecBufferAttr *, void *);
};
struct OH_AVCodec {
    int generation = 0;
    bool active = false;
    bool flushed = false;
    OH_AVCodecCallback callback {};
    void *data = nullptr;
    std::map<uint32_t, OH_AVMemory *> inputs, outputs;
};

namespace Mock {
struct Counts { int create = 0, destroy = 0, start = 0, seek = 0, configure = 0, prepare = 0, push = 0, free = 0, invalid = 0, flush = 0, read = 0; };
std::mutex mutex;
std::condition_variable changed;
Counts counts;
std::vector<std::unique_ptr<OH_AVCodec>> codecs;
std::vector<std::unique_ptr<OH_AVMemory>> memories;
uint32_t nextIndex = 0;
int64_t seekMilliseconds = 0;
bool failSeek = false;
bool failFlush = false, failRestart = false, blockFlush = false, flushEntered = false, emitFlushCallbacks = false;
std::string mime = "video/mock";
std::vector<uint8_t> config;
std::vector<uint8_t> sample;
uint32_t sampleFlags = 0;
struct Pushed { OH_AVCodecBufferAttr attr; std::vector<uint8_t> data; };
std::vector<Pushed> pushed;

void Require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}

template<class Predicate> void Wait(std::unique_lock<std::mutex> &lock, Predicate predicate, const char *message) {
    // The deadline detects a broken protocol; no elapsed-time performance assertion is made.
    Require(changed.wait_for(lock, std::chrono::seconds(5), predicate), message);
}

Counts Snapshot() { std::lock_guard<std::mutex> lock(mutex); return counts; }

OH_AVMemory *Allocate(OH_AVCodec *codec, bool output, bool block = false, bool eos = false) {
    std::lock_guard<std::mutex> lock(mutex);
    Require(codec && codec->active, "mock callback must belong to an active codec generation");
    auto memory = std::make_unique<OH_AVMemory>();
    memory->owner = codec; memory->index = ++nextIndex; memory->generation = codec->generation;
    if (!output) memory->bytes.resize(256);
    memory->block = block; memory->sampleEos = eos;
    auto pointer = memory.get();
    (output ? codec->outputs : codec->inputs).emplace(pointer->index, pointer);
    memories.push_back(std::move(memory));
    return pointer;
}

OH_AVMemory *Input(OH_AVCodec *codec, bool eos = false) {
    auto memory = Allocate(codec, false, false, eos);
    codec->callback.input(codec, memory->index, memory, codec->data);
    return memory;
}

OH_AVMemory *Output(OH_AVCodec *codec, int64_t pts, bool block = false, bool eos = false) {
    auto memory = Allocate(codec, true, block);
    OH_AVCodecBufferAttr attr {0, eos ? 0 : int32_t(memory->bytes.size()), pts, eos ? AVCODEC_BUFFER_FLAGS_EOS : 0};
    codec->callback.output(codec, memory->index, memory, &attr, codec->data);
    return memory;
}

void WaitPushed(OH_AVMemory *memory) {
    std::unique_lock<std::mutex> lock(mutex);
    Wait(lock, [=] { return memory->consumed; }, "input callback buffer was not returned to its codec");
}
void WaitInitialPush() {
    std::unique_lock<std::mutex> lock(mutex);
    Wait(lock, [] { return counts.push >= 1; }, "synchronous Start input callback was lost");
}
void WaitFreed(OH_AVMemory *memory) {
    std::unique_lock<std::mutex> lock(mutex);
    Wait(lock, [=] { return memory->freed; }, "output callback buffer was not released");
}
void WaitEntered(OH_AVMemory *memory) {
    std::unique_lock<std::mutex> lock(mutex);
    Wait(lock, [=] { return memory->entered; }, "production conversion did not reach the manual gate");
}
void Release() {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto &memory : memories) memory->block = false;
    blockFlush = false;
    changed.notify_all();
}
struct GateGuard { ~GateGuard() { Release(); } };

OH_AVErrCode Invalid() { ++counts.invalid; changed.notify_all(); return AV_ERR_INVALID; }
} // namespace Mock

OH_AVSource *OH_AVSource_CreateWithURI(char *) { return new OH_AVSource; }
OH_AVSource *OH_AVSource_CreateWithFD(int, int64_t, int64_t) { return new OH_AVSource; }
void OH_AVSource_Destroy(OH_AVSource *source) { delete source; }
OH_AVFormat *OH_AVSource_GetSourceFormat(OH_AVSource *) {
    auto format = new OH_AVFormat; format->values[OH_MD_KEY_TRACK_COUNT] = 1; return format;
}
OH_AVFormat *OH_AVSource_GetTrackFormat(OH_AVSource *, int) {
    auto format = new OH_AVFormat;
    format->mime = Mock::mime; format->config = Mock::config;
    format->values[OH_MD_KEY_WIDTH] = 2; format->values[OH_MD_KEY_HEIGHT] = 2; return format;
}
void OH_AVFormat_Destroy(OH_AVFormat *format) { delete format; }
bool OH_AVFormat_GetIntValue(OH_AVFormat *format, const char *key, int32_t *value) {
    auto found = format->values.find(key);
    if (found == format->values.end()) return false;
    *value = found->second; return true;
}
bool OH_AVFormat_GetStringValue(OH_AVFormat *format, const char *, const char **value) { *value = format->mime.c_str(); return true; }
bool OH_AVFormat_GetBuffer(OH_AVFormat *format, const char *, uint8_t **value, size_t *size) {
    *value = format->config.data(); *size = format->config.size(); return !format->config.empty();
}
bool OH_AVFormat_SetIntValue(OH_AVFormat *format, const char *key, int32_t value) { format->values[key] = value; return true; }
OH_AVDemuxer *OH_AVDemuxer_CreateWithSource(OH_AVSource *) { return new OH_AVDemuxer; }
void OH_AVDemuxer_Destroy(OH_AVDemuxer *demuxer) { delete demuxer; }
OH_AVErrCode OH_AVDemuxer_SelectTrackByID(OH_AVDemuxer *, uint32_t) { return AV_ERR_OK; }
OH_AVErrCode OH_AVDemuxer_SeekToTime(OH_AVDemuxer *, int64_t milliseconds, int) {
    std::lock_guard<std::mutex> lock(Mock::mutex);
    ++Mock::counts.seek; Mock::seekMilliseconds = milliseconds;
    return Mock::failSeek ? AV_ERR_SEEK : AV_ERR_OK;
}
OH_AVErrCode OH_AVDemuxer_ReadSample(OH_AVDemuxer *, uint32_t, OH_AVMemory *memory, OH_AVCodecBufferAttr *attr) {
    std::lock_guard<std::mutex> lock(Mock::mutex);
    if (!memory->owner->active || memory->generation != memory->owner->generation || memory->consumed) return Mock::Invalid();
    ++Mock::counts.read;
    if (!Mock::sample.empty()) std::copy(Mock::sample.begin(), Mock::sample.end(), memory->bytes.begin());
    *attr = {0, Mock::sample.empty() ? 6 : static_cast<int32_t>(Mock::sample.size()), Mock::seekMilliseconds * 1000,
        memory->sampleEos ? AVCODEC_BUFFER_FLAGS_EOS : Mock::sampleFlags};
    return AV_ERR_OK;
}
OH_AVCodec *OH_VideoDecoder_CreateByMime(const char *) {
    std::lock_guard<std::mutex> lock(Mock::mutex);
    auto codec = std::make_unique<OH_AVCodec>(); codec->generation = ++Mock::counts.create;
    auto pointer = codec.get(); Mock::codecs.push_back(std::move(codec)); return pointer;
}
OH_AVErrCode OH_VideoDecoder_SetCallback(OH_AVCodec *codec, OH_AVCodecCallback callback, void *data) {
    codec->callback = callback; codec->data = data; return AV_ERR_OK;
}
OH_AVErrCode OH_VideoDecoder_Configure(OH_AVCodec *, OH_AVFormat *) {
    std::lock_guard<std::mutex> lock(Mock::mutex); ++Mock::counts.configure; return AV_ERR_OK;
}
OH_AVErrCode OH_VideoDecoder_Prepare(OH_AVCodec *) {
    std::lock_guard<std::mutex> lock(Mock::mutex); ++Mock::counts.prepare; return AV_ERR_OK;
}
OH_AVErrCode OH_VideoDecoder_Start(OH_AVCodec *codec) {
    if (codec->flushed && Mock::failRestart) return AV_ERR_INVALID;
    { std::lock_guard<std::mutex> lock(Mock::mutex); codec->active = true; ++Mock::counts.start; }
    // The native codec may call back synchronously before Start returns.
    Mock::Input(codec);
    return AV_ERR_OK;
}
OH_AVErrCode OH_VideoDecoder_Flush(OH_AVCodec *codec) {
    {
        std::unique_lock<std::mutex> lock(Mock::mutex);
        ++Mock::counts.flush; Mock::flushEntered = true; Mock::changed.notify_all();
        Mock::Wait(lock, [] { return !Mock::blockFlush; }, "Flush barrier gate was not released");
        if (Mock::failFlush) return AV_ERR_INVALID;
    }
    if (Mock::emitFlushCallbacks) { Mock::Input(codec); Mock::Output(codec, 999999); }
    std::lock_guard<std::mutex> lock(Mock::mutex);
    ++codec->generation; codec->flushed = true;
    return AV_ERR_OK;
}
OH_AVErrCode OH_VideoDecoder_Destroy(OH_AVCodec *codec) {
    std::lock_guard<std::mutex> lock(Mock::mutex);
    Mock::Require(codec->active, "codec generation must only be destroyed once");
    codec->active = false; ++Mock::counts.destroy; Mock::changed.notify_all(); return AV_ERR_OK;
}
OH_AVErrCode OH_VideoDecoder_PushInputData(OH_AVCodec *codec, uint32_t index, OH_AVCodecBufferAttr attr) {
    std::lock_guard<std::mutex> lock(Mock::mutex);
    auto found = codec->inputs.find(index);
    if (!codec->active || found == codec->inputs.end() || found->second->consumed || found->second->generation != codec->generation)
        return Mock::Invalid();
    Mock::pushed.push_back({attr, std::vector<uint8_t>(found->second->bytes.begin() + attr.offset,
        found->second->bytes.begin() + attr.offset + attr.size)});
    found->second->consumed = true; ++Mock::counts.push; Mock::changed.notify_all(); return AV_ERR_OK;
}
OH_AVErrCode OH_VideoDecoder_FreeOutputData(OH_AVCodec *codec, uint32_t index) {
    std::lock_guard<std::mutex> lock(Mock::mutex);
    auto found = codec->outputs.find(index);
    if (!codec->active || found == codec->outputs.end() || found->second->freed || found->second->generation != codec->generation)
        return Mock::Invalid();
    found->second->freed = true; ++Mock::counts.free; Mock::changed.notify_all(); return AV_ERR_OK;
}
OH_AVFormat *OH_VideoDecoder_GetOutputDescription(OH_AVCodec *) {
    auto format = new OH_AVFormat;
    format->values[OH_MD_KEY_VIDEO_PIC_WIDTH] = 2; format->values[OH_MD_KEY_VIDEO_PIC_HEIGHT] = 2;
    format->values[OH_MD_KEY_VIDEO_STRIDE] = 2; format->values[OH_MD_KEY_VIDEO_SLICE_HEIGHT] = 2;
    format->values[OH_MD_KEY_PIXEL_FORMAT] = AV_PIXEL_FORMAT_NV12; return format;
}
int OH_AVMemory_GetSize(OH_AVMemory *memory) { return int(memory->bytes.size()); }
uint8_t *OH_AVMemory_GetAddr(OH_AVMemory *memory) {
    std::unique_lock<std::mutex> lock(Mock::mutex);
    if (memory->block) {
        memory->entered = true; Mock::changed.notify_all();
        Mock::Wait(lock, [=] { return !memory->block; }, "conversion gate was never released");
    }
    return memory->bytes.data();
}

// Generated from the complete production Decoder, without its N-API registration tail.
#include "production-decoder.h"

namespace {
std::string inputPath;

void Start(Decoder &decoder, int mode = 1) {
    auto size = decoder.Start(inputPath, mode, decoder.startGate.Capture());
    Mock::Require(size == std::make_pair(2, 2), "real Decoder Start did not select the mocked video track");
    Mock::WaitInitialPush();
}

void QueueFrame(Decoder &decoder, int64_t pts) { Mock::WaitFreed(Mock::Output(decoder.codec, pts)); }

Frame Take(Decoder &decoder) {
    Frame frame {}; bool eof = false; std::string error;
    Mock::Require(decoder.Next(frame, eof, error), "expected a converted frame: " + error);
    Mock::Require(frame.width == 2 && frame.height == 2 && frame.pixels.size() == 16, "frame was not converted by production Convert");
    for (size_t index = 3; index < frame.pixels.size(); index += 4)
        Mock::Require(frame.pixels[index] == 255, "converted alpha must remain opaque");
    return frame;
}

void Deliver(Decoder &decoder, int64_t pts = 100000) {
    QueueFrame(decoder, pts);
    Mock::Require(Take(decoder).pts == pts, "delivered PTS changed");
    std::lock_guard<std::mutex> lock(decoder.mutex);
    Mock::Require(decoder.hasDeliveredFrame && decoder.lastDeliveredPts == pts, "Next must track the last actually delivered frame");
}

void NoRebuild(const Mock::Counts &before) {
    auto after = Mock::Snapshot();
    Mock::Require(after.create == before.create && after.destroy == before.destroy && after.start == before.start &&
        after.seek == before.seek && after.configure == before.configure && after.prepare == before.prepare,
        "forward seek unexpectedly called codec rebuild or demuxer seek APIs");
    Mock::Require(after.invalid == 0, "codec used a buffer from an invalid generation");
}

void Rebuilt(const Mock::Counts &before, Decoder &decoder, OH_AVCodec *oldCodec) {
    auto after = Mock::Snapshot();
    Mock::Require(after.create == before.create + 1 && after.destroy == before.destroy + 1 &&
        after.start == before.start + 1 && after.seek == before.seek + 1, "seek did not use the original rebuild path");
    Mock::Require(decoder.codec != oldCodec && !oldCodec->active && decoder.codec->active,
        "rebuilt codec must invalidate the previous buffer generation");
    Mock::Require(after.invalid == 0, "rebuilt codec consumed a stale buffer index");
    std::lock_guard<std::mutex> lock(decoder.mutex);
    Mock::Require(!decoder.hasDeliveredFrame && decoder.frames.empty(), "rebuild must reset delivered marker and converted frames");
}

void Paused(Decoder &decoder) {
    std::unique_lock<std::mutex> lock(decoder.mutex);
    Mock::Require(decoder.cv.wait_for(lock, std::chrono::seconds(5), [&] { return decoder.pausing; }), "seek did not pause the production pump");
}

struct Seeking {
    std::exception_ptr error;
    std::atomic<bool> finished {false};
    std::thread thread;
    Seeking(Decoder &decoder, double position) : thread([&, position] {
        try { decoder.Seek(position, decoder.startGate.Capture()); }
        catch (...) { error = std::current_exception(); }
        finished = true;
        Mock::changed.notify_all();
    }) {}
    ~Seeking() { Mock::Release(); if (thread.joinable()) thread.join(); }
    void Finish() { Mock::Release(); thread.join(); }
    void Succeeded() { Finish(); if (error) std::rethrow_exception(error); }
};

std::vector<uint8_t> PagConfig() {
    return {1,77,64,40,255,225,0,25,103,77,64,40,236,160,45,1,19,242,194,0,0,3,0,2,0,0,3,0,97,30,48,99,44,1,0,5,104,234,224,140,178};
}

void HeaderContracts() {
    auto config = PagConfig();
    const auto headers = dimina::video::CodecHeaders("video/avc", config.data(), config.size());
    Mock::Require(headers.size() == 38, "real PAG AVC configuration did not become exact AnnexB SPS/PPS");
    Mock::Require(dimina::video::AnnexBHeaders("video/avc", headers.data(), headers.size()) == headers, "AnnexB parameter bytes changed");
    auto combined = headers;
    combined.insert(combined.end(), {0,0,0,1,0x65,0x88,0x99});
    Mock::Require(dimina::video::AnnexBHeaders("video/avc", combined.data(), combined.size()) == headers, "cache retained an IDR or fabricated frame instead of headers");
    auto malformed = config; malformed.pop_back();
    Mock::Require(dimina::video::CodecHeaders("video/avc", malformed.data(), malformed.size()).empty(), "truncated AVCC accepted");
    malformed = config; malformed[7] = 255;
    Mock::Require(dimina::video::CodecHeaders("video/avc", malformed.data(), malformed.size()).empty(), "AVCC length overflow accepted");
    malformed = config; malformed[8] = 0x65;
    Mock::Require(dimina::video::CodecHeaders("video/avc", malformed.data(), malformed.size()).empty(), "AVCC SPS slot accepted an IDR");
    Mock::Require(dimina::video::CodecHeaders("video/mock", config.data(), config.size()).empty(), "unknown codec accepted headers");
    malformed = {0,0,1,0x67,0x55};
    Mock::Require(dimina::video::CodecHeaders("video/avc", malformed.data(), malformed.size()).empty(), "missing PPS accepted");
    const std::vector<uint8_t> hevc {0,0,1,0x40,1,7,0,0,1,0x42,1,8,0,0,1,0x44,1,9};
    Mock::Require(dimina::video::CodecHeaders("video/hevc", hevc.data(), hevc.size()).size() == 21, "AnnexB HEVC VPS/SPS/PPS not accepted");
    Mock::Require(dimina::video::CodecHeaders("video/hevc", config.data(), config.size()).empty(), "unknown hvcC format guessed");
    malformed = config; malformed.resize(dimina::video::MAX_CODEC_HEADER_BYTES + 1);
    Mock::Require(dimina::video::CodecHeaders("video/avc", malformed.data(), malformed.size()).empty(), "header capacity overflow accepted");
}

void FlushCase(const std::string &name) {
    Mock::mime = "video/avc";
    Mock::config = PagConfig();
    if (name == "flush-inband" || name == "flush-no-headers") Mock::config.clear();
    if (name == "flush-bad-headers") Mock::config.pop_back();
    const auto originalConfig = PagConfig();
    const auto expected = dimina::video::CodecHeaders("video/avc", originalConfig.data(), originalConfig.size());
    if (name == "flush-inband") {
        Mock::sample = expected;
        Mock::sample.insert(Mock::sample.end(), {0,0,0,1,0x65,0x88,0x99});
        Mock::sampleFlags = AVCODEC_BUFFER_FLAGS_SYNC_FRAME;
    }
    Decoder decoder;
    Mock::GateGuard gate;
    Start(decoder); Deliver(decoder);
    auto oldCodec = decoder.codec;
    auto before = Mock::Snapshot();
    if (name == "flush-failure") Mock::failFlush = true;
    if (name == "flush-start-failure") Mock::failRestart = true;
    if (name == "flush-eos") {
        Mock::WaitPushed(Mock::Input(oldCodec, true));
        Mock::WaitFreed(Mock::Output(oldCodec, 100000, false, true));
        before = Mock::Snapshot();
    }
    if (name == "flush-owned") decoder.format->config.assign(41, 0xff);
    if (name == "flush-cancel" || name == "flush-removed") {
        { std::lock_guard<std::mutex> lock(Mock::mutex); Mock::blockFlush = true; }
        Seeking seeking(decoder, 50);
        { std::unique_lock<std::mutex> lock(Mock::mutex);
          Mock::Wait(lock, [] { return Mock::flushEntered; }, "seek did not reach callback Flush barrier"); }
        decoder.startGate.Cancel();
        if (name == "flush-removed") decoder.removed = true;
        seeking.Finish();
        Mock::Require(bool(seeking.error), "cancel during Flush did not reject");
        auto after = Mock::Snapshot();
        Mock::Require(after.start == before.start && after.create == before.create && decoder.codec == nullptr &&
            !decoder.pump.joinable() && decoder.frames.empty(), "cancelled Flush started or retained a codec/pump/frame");
        return;
    }
    OH_AVMemory *staleInput = nullptr, *staleOutput = nullptr;
    if (name == "flush-indices") {
        QueueFrame(decoder, 150000); QueueFrame(decoder, 175000);
        staleInput = Mock::Input(oldCodec); staleOutput = Mock::Output(oldCodec, 250000);
        Mock::emitFlushCallbacks = true;
    }
    decoder.Seek(50, decoder.startGate.Capture());
    if (name == "flush-no-headers" || name == "flush-bad-headers" || name == "flush-failure" || name == "flush-start-failure") {
        Rebuilt(before, decoder, oldCodec);
        auto after = Mock::Snapshot();
        Mock::Require(after.flush == before.flush + (name == "flush-failure" || name == "flush-start-failure"), "unsupported parameters guessed a Flush path");
        return;
    }
    auto after = Mock::Snapshot();
    Mock::Require(decoder.codec == oldCodec && after.create == before.create && after.destroy == before.destroy &&
        after.configure == before.configure && after.prepare == before.prepare && after.flush == before.flush + 1 &&
        after.start == before.start + 1 && after.seek == before.seek + 1, "trusted backward seek rebuilt instead of Flush/Start reuse");
    if (staleInput) {
        std::lock_guard<std::mutex> lock(decoder.mutex);
        for (const auto &buffer : decoder.inputs) Mock::Require(buffer.memory->generation == decoder.codec->generation,
            "old input index crossed the Flush callback barrier");
        for (const auto &buffer : decoder.outputs) Mock::Require(buffer.memory->generation == decoder.codec->generation,
            "old output index crossed the Flush callback barrier");
        Mock::Require(decoder.failure.empty() && Mock::Snapshot().invalid == 0, "Flush used a stale callback buffer");
    }
    {
        std::unique_lock<std::mutex> lock(Mock::mutex);
        Mock::Wait(lock, [&] { return Mock::pushed.size() > static_cast<size_t>(before.push); }, "fresh input was not consumed");
        const auto &head = Mock::pushed.back();
        Mock::Require((head.attr.flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA) && head.data == expected && head.attr.size == 38 && head.attr.offset == 0,
            "restarted codec did not get owned AnnexB-only parameter data");
        Mock::Require(Mock::counts.read == before.read, "CSD resend incorrectly advanced the demuxer");
    }
    if (staleInput) Mock::Require(!staleInput->consumed && !staleOutput->freed, "Flush reused/released invalid old buffer indices");
    auto input = Mock::Input(oldCodec); Mock::WaitPushed(input);
    {
        std::lock_guard<std::mutex> lock(Mock::mutex);
        Mock::Require(Mock::pushed.back().attr.pts == 50000, "ordinary demuxed frame PTS was fabricated");
        if (name == "flush-inband") Mock::Require(Mock::pushed.back().data == Mock::sample, "combined original IDR/sample was modified");
    }
    QueueFrame(decoder, 50000);
    Mock::Require(Take(decoder).pts == 50000, "restarted codec failed to deliver exact post-seek frame");
    Mock::Require(Mock::Snapshot().invalid == 0, "Flush crossed a callback buffer generation");
}

void RunningForwardCase(const std::string &name) {
    Decoder decoder;
    Mock::GateGuard gate;
    Start(decoder); Deliver(decoder);
    if (name == "callbacks") QueueFrame(decoder, 150000);
    auto codec = decoder.codec;
    const auto pumpId = decoder.pump.get_id();
    const int64_t pts = name == "inflight-above" ? 250000 : 175000;
    auto blocked = Mock::Output(codec, pts, true);
    Mock::WaitEntered(blocked);
    const auto before = Mock::Snapshot();
    Seeking seeking(decoder, 200);
    {
        std::unique_lock<std::mutex> lock(Mock::mutex);
        Mock::Wait(lock, [&] { return seeking.finished.load(); }, "forward seek joined an in-flight conversion instead of returning");
        Mock::Require(blocked->block, "test conversion gate was released before forward seek returned");
    }
    if (seeking.error) std::rethrow_exception(seeking.error);
    Mock::Require(decoder.pump.get_id() == pumpId, "forward seek recreated its running pump thread");
    {
        std::lock_guard<std::mutex> lock(decoder.mutex);
        Mock::Require(!decoder.pausing && !decoder.stopping && decoder.targetUs == 200000,
            "forward seek paused or stopped the live pump");
    }
    OH_AVMemory *pendingInput = nullptr, *pendingOutput = nullptr;
    if (name == "callbacks") {
        pendingOutput = Mock::Output(codec, 250000); pendingInput = Mock::Input(codec);
        Frame frame {}; bool eof = false; std::string error;
        Mock::Require(!decoder.Next(frame, eof, error), "old buffered frame was delivered after the new forward target");
        std::lock_guard<std::mutex> lock(decoder.mutex);
        Mock::Require(decoder.outputs.size() == 1 && decoder.inputs.size() == 1,
            "live forward seek discarded callback-owned buffers");
    }
    seeking.Succeeded(); Mock::WaitFreed(blocked);
    if (name == "callbacks") {
        Mock::WaitFreed(pendingOutput); Mock::WaitPushed(pendingInput);
        Mock::Require(Take(decoder).pts == 250000, "live callbacks did not resume with the same codec pool");
    } else if (name == "inflight-above") {
        Mock::Require(Take(decoder).pts == 250000, "new-target eligible conversion was discarded");
    } else {
        std::lock_guard<std::mutex> lock(decoder.mutex);
        Mock::Require(decoder.frames.empty(), "old in-flight conversion committed below the latest target");
    }
    NoRebuild(before);
}

void Run(const std::string &name) {
    if (name.rfind("direct-", 0) == 0) {
        Decoder decoder; Start(decoder); Deliver(decoder);
        QueueFrame(decoder, 150000); QueueFrame(decoder, 250000);
        const auto before = Mock::Snapshot(); const auto pump = decoder.pump.get_id();
        if (name == "direct-pending") decoder.pendingControls = 1;
        else if (name == "direct-removed") decoder.removed = true;
        else if (name == "direct-eos") decoder.inputEnded = true;
        else if (name == "direct-same") {
            Mock::Require(!decoder.TrySeekForward(100), "same delivered frame incorrectly used direct forward seek");
            NoRebuild(before); return;
        } else if (name == "direct-busy") {
            std::lock_guard<std::mutex> lock(decoder.control);
            bool advanced = true;
            std::thread attempt([&] { advanced = decoder.TrySeekForward(200); }); attempt.join();
            Mock::Require(!advanced && decoder.targetUs == 0, "direct seek bypassed a busy control gate");
            NoRebuild(before); return;
        }
        const bool advanced = decoder.TrySeekForward(200);
        if (name != "direct-forward") {
            Mock::Require(!advanced && decoder.targetUs == 0 && decoder.frames.size() == 2,
                "ineligible direct seek changed the target or queue instead of falling back");
        } else {
            Mock::Require(advanced && decoder.targetUs == 200000 && decoder.pump.get_id() == pump,
                "eligible direct seek failed to advance the live pump");
            Mock::Require(Take(decoder).pts == 250000, "direct seek retained a frame below its target");
        }
        NoRebuild(before); return;
    }
    if (name == "headers") { HeaderContracts(); return; }
    if (name.rfind("flush-", 0) == 0) { FlushCase(name); return; }
    if (name == "inflight-below" || name == "inflight-above" || name == "callbacks") { RunningForwardCase(name); return; }
    Decoder decoder;
    Mock::GateGuard gate;
    Start(decoder, name == "clock" ? 0 : 1);
    if (name != "undelivered") Deliver(decoder);

    if (name == "fast-preserve" || name == "clock") {
        QueueFrame(decoder, 150000); QueueFrame(decoder, 250000);
        auto before = Mock::Snapshot();
        if (name == "clock") {
            std::lock_guard<std::mutex> lock(decoder.mutex);
            decoder.clock = std::chrono::steady_clock::now() + std::chrono::hours(1);
            decoder.clockStarted = true;
        }
        decoder.Seek(200, decoder.startGate.Capture());
        NoRebuild(before);
        { std::lock_guard<std::mutex> lock(decoder.mutex);
          Mock::Require(!decoder.clockStarted && decoder.targetUs == 200000, "forward seek must reset target and playback clock"); }
        Mock::Require(Take(decoder).pts == 250000, "forward seek must retain the already-converted frame above target");
        if (name == "clock") {
            std::lock_guard<std::mutex> lock(decoder.mutex);
            Mock::Require(decoder.clockPts == 250000, "mode zero must rebase its clock to the first post-seek frame");
        }
    } else if (name == "target-first") {
        auto before = Mock::Snapshot();
        decoder.Seek(200, decoder.startGate.Capture());
        QueueFrame(decoder, 150000);
        { std::lock_guard<std::mutex> lock(decoder.mutex); Mock::Require(decoder.frames.empty(), "pre-target frame escaped filtering"); }
        QueueFrame(decoder, 200000);
        Mock::Require(Take(decoder).pts == 200000, "first returned frame must be at the requested target");
        NoRebuild(before);
    } else if (name == "inflight-below" || name == "inflight-above" || name == "callbacks" ||
               name == "cancel" || name == "removed" || name == "error-during") {
        if (name == "callbacks") QueueFrame(decoder, 150000);
        auto oldCodec = decoder.codec;
        const int64_t inFlightPts = name == "inflight-below" || name == "callbacks" ? 175000 : 250000;
        auto blocked = Mock::Output(oldCodec, inFlightPts, true);
        Mock::WaitEntered(blocked);
        if (name == "cancel" || name == "removed" || name == "error-during") {
            std::lock_guard<std::mutex> lock(decoder.mutex); decoder.targetUs = 300000;
        }
        auto before = Mock::Snapshot();
        Seeking seeking(decoder, 200);
        Paused(decoder);
        Mock::Require(!seeking.finished, "seek completed without joining the in-flight conversion");
        OH_AVMemory *pendingOutput = nullptr, *pendingInput = nullptr;
        if (name == "callbacks") {
            Frame frame {}; bool eof = false; std::string error;
            Mock::Require(!decoder.Next(frame, eof, error), "Next must not deliver a pre-target frame while paused");
            pendingOutput = Mock::Output(oldCodec, 250000);
            pendingInput = Mock::Input(oldCodec);
            std::lock_guard<std::mutex> lock(decoder.mutex);
            Mock::Require(decoder.outputs.size() == 1 && decoder.inputs.size() == 1,
                "pause discarded input/output callbacks and would stall the codec buffer pool");
        } else if (name == "cancel" || name == "removed") {
            decoder.startGate.Cancel();
            if (name == "removed") decoder.removed = true;
        } else if (name == "error-during") {
            oldCodec->callback.error(oldCodec, 91, oldCodec->data);
        }
        seeking.Finish();
        if (name == "cancel" || name == "removed") {
            Mock::Require(bool(seeking.error), "cancelled seek must reject");
            std::lock_guard<std::mutex> lock(decoder.mutex);
            Mock::Require(decoder.stopping && !decoder.pump.joinable() && decoder.codec == nullptr && decoder.frames.empty(),
                "cancelled seek resumed the pump or committed an in-flight frame");
            Mock::Require(Mock::Snapshot().create == before.create, "cancelled seek created another codec");
        } else {
            if (seeking.error) std::rethrow_exception(seeking.error);
            if (name == "error-during") {
                Rebuilt(before, decoder, oldCodec);
                QueueFrame(decoder, 200000);
                Mock::Require(Take(decoder).pts == 200000, "rebuilt decoder did not recover after pause-time error");
            } else {
                NoRebuild(before);
                if (name == "callbacks") {
                    Mock::WaitFreed(pendingOutput); Mock::WaitPushed(pendingInput);
                    Mock::Require(Take(decoder).pts == 250000, "paused output callback did not resume with its original codec generation");
                } else if (name == "inflight-above") {
                    Mock::Require(Take(decoder).pts == 250000, "eligible in-flight conversion was discarded while joining");
                } else {
                    std::lock_guard<std::mutex> lock(decoder.mutex);
                    Mock::Require(decoder.frames.empty(), "in-flight old conversion committed below target after seek returned");
                }
            }
        }
    } else if (name == "rebuild-failure") {
        Mock::WaitFreed(Mock::Output(decoder.codec, 100000, false, true));
        { std::lock_guard<std::mutex> lock(Mock::mutex); Mock::failSeek = true; }
        bool rejected = false;
        try { decoder.Seek(200, decoder.startGate.Capture()); } catch (const std::runtime_error &) { rejected = true; }
        Mock::Require(rejected, "demuxer seek failure must reject");
        std::lock_guard<std::mutex> lock(decoder.mutex);
        Mock::Require(decoder.stopping && decoder.codec == nullptr && !decoder.pump.joinable() && decoder.frames.empty(),
            "failed seek rebuild left an active pump, codec or converted frame");
    } else if (name == "invalid-position" || name == "stale-generation") {
        QueueFrame(decoder, 150000);
        auto before = Mock::Snapshot(); auto oldCodec = decoder.codec;
        const auto token = decoder.startGate.Capture();
        if (name == "stale-generation") decoder.startGate.Cancel();
        const std::vector<double> positions = name == "stale-generation" ? std::vector<double>{200} :
            std::vector<double>{-1.0, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN(), double(INT64_MAX) / 1000};
        for (double position : positions) {
            bool rejected = false;
            try { decoder.Seek(position, token); } catch (const std::runtime_error &) { rejected = true; }
            Mock::Require(rejected, "invalid seek request did not reject");
            Mock::Require(decoder.codec == oldCodec && oldCodec->active, "invalid seek request tore down the active decoder");
            std::lock_guard<std::mutex> lock(decoder.mutex);
            Mock::Require(decoder.frames.size() == 1 && decoder.frames.front().pts == 150000 && decoder.hasDeliveredFrame &&
                decoder.lastDeliveredPts == 100000 && !decoder.pausing && !decoder.stopping,
                "invalid seek request cleared queued frames or changed the active decoder state");
        }
        NoRebuild(before);
        Mock::Require(Take(decoder).pts == 150000, "queued frame became unavailable after rejected seek");
    } else {
        double position = 200;
        if (name == "same-frame") position = 100;
        else if (name == "backward") position = 50;
        else if (name == "output-eos") Mock::WaitFreed(Mock::Output(decoder.codec, 100000, false, true));
        else if (name == "input-eos") Mock::WaitPushed(Mock::Input(decoder.codec, true));
        else if (name == "error-before") decoder.codec->callback.error(decoder.codec, 71, decoder.codec->data);
        else if (name == "nested-target") {
            auto initial = Mock::Snapshot();
            decoder.Seek(300, decoder.startGate.Capture()); NoRebuild(initial);
            position = 200;
        } else Mock::Require(name == "undelivered", "unknown seek fixture case");
        auto before = Mock::Snapshot(); auto oldCodec = decoder.codec;
        decoder.Seek(position, decoder.startGate.Capture());
        Rebuilt(before, decoder, oldCodec);
        QueueFrame(decoder, int64_t(position * 1000));
        Mock::Require(Take(decoder).pts == int64_t(position * 1000), "rebuilt decoder did not deliver at its requested target");
    }
    Mock::Require(Mock::Snapshot().invalid == 0, "fixture observed invalid codec-generation buffer access");
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 3) { std::cerr << "expected case name and source file\n"; return 1; }
    inputPath = argv[2];
    try { Run(argv[1]); return 0; }
    catch (const std::exception &error) { std::cerr << argv[1] << ": " << error.what() << '\n'; return 1; }
}
