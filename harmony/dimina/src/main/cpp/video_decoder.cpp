#include "video_decoder.h"
#include "video_decoder_control.h"
#include "video_decoder_pixels.h"
#include "video_decoder_headers.h"
#include <multimedia/player_framework/native_avcodec_videodecoder.h>
#include <multimedia/player_framework/native_avcapability.h>
#include <multimedia/player_framework/native_avdemuxer.h>
#include <multimedia/player_framework/native_avsource.h>
#include <multimedia/player_framework/native_avmemory.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <fcntl.h>
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

namespace {
void Check(OH_AVErrCode result) {
    if (result != AV_ERR_OK) throw std::runtime_error("AVCodec error " + std::to_string(result));
}
int Int(OH_AVFormat *format, const char *key, int fallback) {
    int32_t value = fallback;
    OH_AVFormat_GetIntValue(format, key, &value);
    return value;
}
void CheckSize(int width, int height) {
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096 ||
        int64_t(width) * height > 2097152) throw std::runtime_error("video frame exceeds pixel budget");
}
OH_AVCodec *CreateDecoder(const std::string &mime, int width, int height) {
    auto create = [width, height](OH_AVCapability *capability) -> OH_AVCodec * {
        if (!capability || !OH_AVCapability_IsVideoSizeSupported(capability, width, height)) return nullptr;
        const int32_t *formats = nullptr;
        uint32_t count = 0;
        if (OH_AVCapability_GetVideoSupportedPixelFormats(capability, &formats, &count) != AV_ERR_OK || !formats ||
            std::find(formats, formats + count, AV_PIXEL_FORMAT_NV12) == formats + count) return nullptr;
        const char *name = OH_AVCapability_GetName(capability);
        return name && *name ? OH_VideoDecoder_CreateByName(name) : nullptr;
    };
    // CreateByMime always selects the system recommendation. Its hardware
    // decoder may reject a small video that the software decoder supports.
    if (auto codec = create(OH_AVCodec_GetCapability(mime.c_str(), false))) return codec;
    if (auto codec = create(OH_AVCodec_GetCapabilityByCategory(mime.c_str(), false, HARDWARE))) return codec;
    if (auto codec = create(OH_AVCodec_GetCapabilityByCategory(mime.c_str(), false, SOFTWARE))) return codec;
    throw std::runtime_error("no video decoder supports " + mime + " " + std::to_string(width) + "x" +
        std::to_string(height) + " with NV12 output");
}
struct Frame { int width, height; int64_t pts; std::vector<uint8_t> pixels; std::shared_ptr<const dimina::canvas::PreparedCanvasPixels> prepared; };
struct Buffer { uint32_t index; OH_AVMemory *memory; OH_AVCodecBufferAttr attr {}; };
struct Layout {
    int width = 0, height = 0, stride = 0, slice = 0, left = 0, top = 0;
    int pixelFormat = AV_PIXEL_FORMAT_NV12;
    bool fullRange = false, bt709 = false;
};

class Decoder {
public:
    std::atomic<bool> removed {false};
    std::atomic<uint32_t> pendingControls {0};
    VideoDecoderStartGate startGate;
    // Control operations run on N-API's async pool; they never block the service worker.
    std::mutex control;
    ~Decoder() { Stop(); }

    std::pair<int, int> Start(const std::string &path, int mode, uint64_t generation) {
        startGate.CheckCurrent(generation);
        Stop();
        if (removed) throw std::runtime_error("decoder removed");
        if (mode != 0 && mode != 1) throw std::runtime_error("invalid mode");
        try {
            if (path.rfind("https://", 0) == 0 || path.rfind("http://", 0) == 0) {
                std::vector<char> uri(path.begin(), path.end()); uri.push_back(0);
                source = OH_AVSource_CreateWithURI(uri.data());
            } else {
                fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
                struct stat statbuf {};
                if (fd < 0 || fstat(fd, &statbuf) || !S_ISREG(statbuf.st_mode)) throw std::runtime_error("cannot open video source");
                source = OH_AVSource_CreateWithFD(fd, 0, statbuf.st_size);
            }
            startGate.CheckCurrent(generation);
            if (!source) throw std::runtime_error("unsupported video source");
            OH_AVFormat *description = OH_AVSource_GetSourceFormat(source);
            if (!description) throw std::runtime_error("missing source metadata");
            int count = Int(description, OH_MD_KEY_TRACK_COUNT, 0);
            OH_AVFormat_Destroy(description);
            for (int i = 0; i < count; ++i) {
                OH_AVFormat *candidate = OH_AVSource_GetTrackFormat(source, i);
                const char *mime = nullptr;
                if (candidate && OH_AVFormat_GetStringValue(candidate, OH_MD_KEY_CODEC_MIME, &mime) &&
                    mime && std::string(mime).rfind("video/", 0) == 0) {
                    track = i; format = candidate; codecMime = mime; break;
                }
                if (candidate) OH_AVFormat_Destroy(candidate);
            }
            if (!format) throw std::runtime_error("no video track");
            width = Int(format, OH_MD_KEY_WIDTH, 0); height = Int(format, OH_MD_KEY_HEIGHT, 0);
            CheckSize(width, height);
            uint8_t *config = nullptr; size_t configSize = 0;
            if (OH_AVFormat_GetBuffer(format, OH_MD_KEY_CODEC_CONFIG, &config, &configSize))
                codecHeaders = dimina::video::CodecHeaders(codecMime, config, configSize);
            demuxer = OH_AVDemuxer_CreateWithSource(source);
            if (!demuxer) throw std::runtime_error("cannot create demuxer");
            Check(OH_AVDemuxer_SelectTrackByID(demuxer, track));
            {
                std::lock_guard<std::mutex> guard(mutex);
                playbackMode = mode;
                targetUs = 0;
            }
            Configure();
            startGate.CheckCurrent(generation);
            if (removed) throw std::runtime_error("decoder removed");
            return {width, height};
        } catch (...) { Stop(); throw; }
    }

    void Seek(double position, uint64_t generation) {
        auto checkCurrent = [this, generation] {
            startGate.CheckCurrent(generation);
            if (removed) throw std::runtime_error("decoder removed");
        };
        checkCurrent();
        if (!demuxer || !std::isfinite(position) || position < 0 || position >= double(INT64_MAX) / 1000)
            throw std::runtime_error("invalid position or stopped decoder");
        const int64_t requestedUs = static_cast<int64_t>(position * 1000);
        try {
            bool forward = false;
            {
                std::lock_guard<std::mutex> guard(mutex);
                // A prior seek may already have discarded frames below targetUs.
                // Such a range cannot be recovered merely by moving the target.
                forward = AdvanceForwardLocked(requestedUs);
                if (!forward) {
                    // A decoder flush/rebuild still needs full pump quiescence.
                    pausing = true;
                }
                cv.notify_all();
            }
            if (forward) {
                checkCurrent();
                return;
            }
            if (pump.joinable()) pump.join();
            checkCurrent();
            {
                bool flushed = false;
                bool demuxSought = false;
                {
                    std::lock_guard<std::mutex> guard(mutex);
                    flushed = codec && failure.empty() && !codecHeaders.empty();
                    if (flushed) stopping = true;
                }
                if (flushed) {
                    // Never hold mutex across Flush: it waits for all preceding
                    // callbacks on this non-callback control thread to finish.
                    flushed = OH_VideoDecoder_Flush(codec) == AV_ERR_OK;
                    checkCurrent();
                    if (flushed) {
                        std::lock_guard<std::mutex> guard(mutex);
                        // Flush invalidates every old index; none may be freed,
                        // pushed or reused after this callback barrier.
                        inputs.clear(); outputs.clear(); frames.clear();
                        ended = false; inputEnded = false; clockStarted = false;
                        hasDeliveredFrame = false; lastDeliveredPts = 0; failure.clear();
                        layout = {}; layout.width = width; layout.height = height;
                    }
                }
                if (flushed) {
                    Check(OH_AVDemuxer_SeekToTime(demuxer, static_cast<int64_t>(position), SEEK_MODE_PREVIOUS_SYNC));
                    demuxSought = true;
                    { std::lock_guard<std::mutex> guard(mutex); targetUs = requestedUs; }
                    checkCurrent();
                    { std::lock_guard<std::mutex> guard(mutex);
                      codecHeadersPending = true; stopping = false; pausing = false; }
                    flushed = OH_VideoDecoder_Start(codec) == AV_ERR_OK;
                    checkCurrent();
                }
                if (flushed) pump = std::thread([this] { Pump(); });
                else {
                    StopCodec();
                    checkCurrent();
                    if (!demuxSought)
                        Check(OH_AVDemuxer_SeekToTime(demuxer, static_cast<int64_t>(position), SEEK_MODE_PREVIOUS_SYNC));
                    { std::lock_guard<std::mutex> guard(mutex); targetUs = requestedUs; }
                    checkCurrent();
                    Configure();
                }
                checkCurrent();
            }
        } catch (...) {
            StopCodec();
            throw;
        }
    }

    bool TrySeekForward(double position) {
        if (!std::isfinite(position) || position < 0 || position >= double(INT64_MAX) / 1000) return false;
        std::unique_lock<std::mutex> controlGuard(control, std::try_to_lock);
        if (!controlGuard.owns_lock() || pendingControls.load() || removed) return false;
        std::lock_guard<std::mutex> guard(mutex);
        if (!AdvanceForwardLocked(static_cast<int64_t>(position * 1000))) return false;
        cv.notify_all();
        return true;
    }

    void Stop() {
        StopCodec();
        if (demuxer) OH_AVDemuxer_Destroy(demuxer);
        if (source) OH_AVSource_Destroy(source);
        if (format) OH_AVFormat_Destroy(format);
        if (fd >= 0) close(fd);
        demuxer = nullptr; source = nullptr; format = nullptr; fd = -1;
        codecHeaders.clear();
    }

    bool Next(Frame &frame, bool &eof, std::string &error) {
        std::lock_guard<std::mutex> guard(mutex);
        if (removed || stopping || pausing) return false;
        error = failure;
        eof = ended && frames.empty();
        if (!error.empty() || frames.empty()) return false;
        auto now = std::chrono::steady_clock::now();
        if (!clockStarted) { clockStarted = true; clock = now; clockPts = frames.front().pts; }
        if (playbackMode == 0 && frames.front().pts - clockPts >
            std::chrono::duration_cast<std::chrono::microseconds>(now - clock).count()) return false;
        frame = std::move(frames.front()); frames.pop_front();
        hasDeliveredFrame = true; lastDeliveredPts = frame.pts; cv.notify_all();
        return true;
    }

private:
    // The control gate and mutex are held by the caller. This path changes only
    // owned target/queue state; driver calls, joins and rebuilds stay asynchronous.
    bool AdvanceForwardLocked(int64_t requestedUs) {
        if (!codec || stopping || !failure.empty() || removed ||
            !hasDeliveredFrame || requestedUs <= lastDeliveredPts || requestedUs < targetUs) return false;
        // Input EOS only finishes compressed input. Output callbacks and an
        // in-flight conversion can still deliver the forward target, so keep
        // draining that codec. After output EOS, require a frame we still own;
        // an exhausted decoder needs the asynchronous seek/recovery path.
        if (ended &&
            std::none_of(frames.begin(), frames.end(), [requestedUs](const Frame &frame) {
                return frame.pts >= requestedUs;
            }) &&
            std::none_of(outputs.begin(), outputs.end(), [requestedUs](const Buffer &buffer) {
                return buffer.attr.size > 0 && buffer.attr.pts >= requestedUs &&
                    !(buffer.attr.flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA);
            })) return false;
        frames.erase(std::remove_if(frames.begin(), frames.end(), [requestedUs](const Frame &frame) {
            return frame.pts < requestedUs;
        }), frames.end());
        targetUs = requestedUs;
        clockStarted = false;
        return true;
    }
    OH_AVSource *source = nullptr;
    OH_AVDemuxer *demuxer = nullptr;
    OH_AVFormat *format = nullptr;
    OH_AVCodec *codec = nullptr;
    int fd = -1, width = 0, height = 0, playbackMode = 1;
    uint32_t track = 0;
    std::string codecMime;
    std::vector<uint8_t> codecHeaders;
    bool codecHeadersPending = false;
    bool codecHeadersProbePending = true;
    int64_t targetUs = 0, clockPts = 0, lastDeliveredPts = 0;
    std::mutex mutex;
    std::condition_variable cv;
    std::thread pump;
    std::deque<Buffer> inputs, outputs;
    std::deque<Frame> frames;
    Layout layout;
    bool stopping = true, pausing = false, ended = false, inputEnded = false, clockStarted = false;
    bool hasDeliveredFrame = false;
    std::string failure;
    std::chrono::steady_clock::time_point clock;

    static void OnError(OH_AVCodec *, int32_t code, void *data) {
        auto self = static_cast<Decoder *>(data);
        std::lock_guard<std::mutex> guard(self->mutex);
        self->failure = "AVCodec error " + std::to_string(code); self->cv.notify_all();
    }
    static void OnFormat(OH_AVCodec *, OH_AVFormat *format, void *data) {
        auto self = static_cast<Decoder *>(data);
        std::lock_guard<std::mutex> guard(self->mutex);
        auto &out = self->layout;
        out.width = Int(format, OH_MD_KEY_VIDEO_PIC_WIDTH, self->width);
        out.height = Int(format, OH_MD_KEY_VIDEO_PIC_HEIGHT, self->height);
        out.stride = Int(format, OH_MD_KEY_VIDEO_STRIDE, 0); out.slice = Int(format, OH_MD_KEY_VIDEO_SLICE_HEIGHT, 0);
        out.left = Int(format, OH_MD_KEY_VIDEO_CROP_LEFT, 0); out.top = Int(format, OH_MD_KEY_VIDEO_CROP_TOP, 0);
        out.pixelFormat = Int(format, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_NV12);
        out.fullRange = Int(format, OH_MD_KEY_RANGE_FLAG, 0) == 1;
        out.bt709 = Int(format, OH_MD_KEY_COLOR_PRIMARIES, 0) == 1;
    }
    static void OnInput(OH_AVCodec *, uint32_t index, OH_AVMemory *memory, void *data) {
        auto self = static_cast<Decoder *>(data);
        std::lock_guard<std::mutex> guard(self->mutex);
        if (!self->stopping) self->inputs.push_back({index, memory});
        self->cv.notify_all();
    }
    static void OnOutput(OH_AVCodec *, uint32_t index, OH_AVMemory *memory, OH_AVCodecBufferAttr *attr, void *data) {
        auto self = static_cast<Decoder *>(data);
        std::lock_guard<std::mutex> guard(self->mutex);
        if (!self->stopping && attr) self->outputs.push_back({index, memory, *attr});
        self->cv.notify_all();
    }
    void Configure() {
        if (removed) throw std::runtime_error("decoder removed");
        {
            std::lock_guard<std::mutex> guard(mutex);
            stopping = false; pausing = false; ended = false; inputEnded = false; clockStarted = false;
            hasDeliveredFrame = false; lastDeliveredPts = 0;
            codecHeadersPending = false;
            codecHeadersProbePending = true;
            failure.clear(); frames.clear(); layout = {}; layout.width = width; layout.height = height;
        }
        codec = CreateDecoder(codecMime, width, height);
        try {
            Check(OH_VideoDecoder_SetCallback(codec, {OnError, OnFormat, OnInput, OnOutput}, this));
            OH_AVFormat_SetIntValue(format, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_NV12);
            Check(OH_VideoDecoder_Configure(codec, format));
            Check(OH_VideoDecoder_Prepare(codec));
            Check(OH_VideoDecoder_Start(codec));
            pump = std::thread([this] { Pump(); });
        } catch (...) { StopCodec(); throw; }
    }
    void StopCodec() {
        { std::lock_guard<std::mutex> guard(mutex); stopping = true; pausing = false; frames.clear(); cv.notify_all(); }
        if (pump.joinable()) pump.join();
        if (codec) OH_VideoDecoder_Destroy(codec);
        codec = nullptr;
        std::lock_guard<std::mutex> guard(mutex);
        inputs.clear(); outputs.clear(); ended = false; failure.clear(); hasDeliveredFrame = false; lastDeliveredPts = 0;
        codecHeadersPending = false;
    }
    void Pump() {
        try {
            while (true) {
                Buffer buffer; Layout pixels; bool output = false;
                int64_t minimumPts = 0;
                {
                    std::unique_lock<std::mutex> guard(mutex);
                    cv.wait(guard, [this] { return stopping || pausing || removed || !failure.empty() ||
                        (frames.size() < 2 && (!outputs.empty() || (!inputs.empty() && !inputEnded))); });
                    if (stopping || pausing || removed || !failure.empty()) return;
                    output = !outputs.empty();
                    auto &buffers = output ? outputs : inputs;
                    buffer = buffers.front(); buffers.pop_front(); pixels = layout;
                    minimumPts = targetUs;
                }
                if (!output) {
                    if (codecHeadersPending) {
                        const int capacity = OH_AVMemory_GetSize(buffer.memory);
                        auto address = OH_AVMemory_GetAddr(buffer.memory);
                        if (!address || capacity < 0 || codecHeaders.size() > static_cast<size_t>(capacity))
                            throw std::runtime_error("codec parameter sets exceed input buffer");
                        std::memcpy(address, codecHeaders.data(), codecHeaders.size());
                        buffer.attr = {0, static_cast<int32_t>(codecHeaders.size()), 0, AVCODEC_BUFFER_FLAGS_CODEC_DATA};
                        codecHeadersPending = false;
                    } else {
                        Check(OH_AVDemuxer_ReadSample(demuxer, track, buffer.memory, &buffer.attr));
                        // Demuxers may combine SPS/PPS with an IDR and mark only
                        // SYNC_FRAME. Probe one bounded initial sample, retaining
                        // its exact original bytes/attributes for normal decode.
                        if (codecHeadersProbePending && codecHeaders.empty() && minimumPts == 0) {
                            const int capacity = OH_AVMemory_GetSize(buffer.memory);
                            auto address = OH_AVMemory_GetAddr(buffer.memory);
                            if (address && buffer.attr.offset >= 0 && buffer.attr.size >= 0 && capacity >= 0 &&
                                static_cast<size_t>(buffer.attr.size) <= dimina::video::MAX_CODEC_PROBE_BYTES &&
                                int64_t(buffer.attr.offset) + buffer.attr.size <= capacity)
                                codecHeaders = dimina::video::AnnexBHeaders(codecMime, address + buffer.attr.offset, buffer.attr.size);
                        }
                        codecHeadersProbePending = false;
                    }
                    if (buffer.attr.flags & AVCODEC_BUFFER_FLAGS_EOS) {
                        std::lock_guard<std::mutex> guard(mutex); inputEnded = true;
                    }
                    Check(OH_VideoDecoder_PushInputData(codec, buffer.index, buffer.attr));
                } else {
                    try {
                        if (pixels.stride == 0 || pixels.slice == 0) {
                            if (auto description = OH_VideoDecoder_GetOutputDescription(codec)) {
                                OnFormat(codec, description, this);
                                OH_AVFormat_Destroy(description);
                                std::lock_guard<std::mutex> guard(mutex); pixels = layout;
                            }
                        }
                        if (buffer.attr.size > 0 && buffer.attr.pts >= minimumPts &&
                            !(buffer.attr.flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA)) {
                            Frame frame = Convert(buffer, pixels);
                            std::lock_guard<std::mutex> guard(mutex);
                            if (!stopping && !removed && frame.pts >= targetUs) frames.push_back(std::move(frame));
                        }
                        if (buffer.attr.flags & AVCODEC_BUFFER_FLAGS_EOS) {
                            std::lock_guard<std::mutex> guard(mutex); ended = true;
                        }
                    } catch (...) { OH_VideoDecoder_FreeOutputData(codec, buffer.index); throw; }
                    Check(OH_VideoDecoder_FreeOutputData(codec, buffer.index));
                }
            }
        } catch (const std::exception &error) {
            std::lock_guard<std::mutex> guard(mutex); failure = error.what();
        }
    }
    Frame Convert(const Buffer &buffer, Layout layout) {
        CheckSize(layout.width, layout.height);
        if (layout.pixelFormat != AV_PIXEL_FORMAT_NV12) throw std::runtime_error("codec does not expose NV12 frames");
        const int size = OH_AVMemory_GetSize(buffer.memory);
        // Never guess padding. Older codecs may omit stride only for a tightly packed frame.
        if (layout.stride == 0 || layout.slice == 0) {
            if (layout.left || layout.top || layout.width % 2 || layout.height % 2 ||
                size != int64_t(layout.width) * layout.height * 3 / 2)
                throw std::runtime_error("codec does not expose decoded buffer layout");
            layout.stride = layout.width; layout.slice = layout.height;
        }
        int64_t uvStart = int64_t(layout.stride) * layout.slice;
        int64_t required = uvStart + int64_t(layout.stride) * ((layout.slice + 1) / 2);
        if (layout.left < 0 || layout.top < 0 || layout.stride < layout.left + layout.width ||
            layout.slice < layout.top + layout.height || layout.stride % 2 || buffer.attr.offset < 0 ||
            required > int64_t(size) - buffer.attr.offset) throw std::runtime_error("invalid decoded buffer layout");
        auto bytes = OH_AVMemory_GetAddr(buffer.memory);
        if (!bytes) throw std::runtime_error("missing decoded pixels");
        bytes += buffer.attr.offset;
        Frame frame {layout.width, layout.height, buffer.attr.pts, std::vector<uint8_t>(layout.width * layout.height * 4), {}};
        dimina::video::ConvertNV12Pixels(bytes,
            {layout.width, layout.height, layout.stride, layout.left, layout.top,
                layout.fullRange, layout.bt709, static_cast<size_t>(uvStart)}, frame.pixels.data());
        if (playbackMode == 1) frame.prepared = dimina::canvas::PrepareCanvasPixels(frame.pixels.data(), frame.pixels.size());
        return frame;
    }
};

using Key = std::pair<int, std::string>;
std::mutex storeMutex;
std::map<Key, std::shared_ptr<Decoder>> store;
std::string String(napi_env env, napi_value value) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) throw std::runtime_error("invalid string argument");
    std::vector<char> result(length + 1);
    napi_get_value_string_utf8(env, value, result.data(), result.size(), &length);
    return std::string(result.data(), length);
}
void Number(napi_env env, napi_value object, const char *key, double value) {
    napi_value result; napi_create_double(env, value, &result); napi_set_named_property(env, object, key, result);
}
void Text(napi_env env, napi_value object, const char *key, const std::string &value) {
    napi_value result; napi_create_string_utf8(env, value.c_str(), value.size(), &result); napi_set_named_property(env, object, key, result);
}
struct Work {
    napi_async_work work = nullptr; napi_deferred deferred;
    std::shared_ptr<Decoder> decoder;
    std::string command, source, error;
    double argument = 0;
    int width = 0, height = 0;
    uint64_t generation = 0;
    bool tracked = false;
    ~Work() { if (tracked) --decoder->pendingControls; }
};
napi_value Operate(napi_env env, napi_callback_info info) {
    size_t argc = 5; napi_value args[5];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    try {
        int32_t owner;
        if (argc < 5 || napi_get_value_int32(env, args[0], &owner) != napi_ok) throw std::runtime_error("invalid decoder arguments");
        auto work = std::make_unique<Work>();
        Key key {owner, String(env, args[1])}; work->command = String(env, args[2]); work->source = String(env, args[3]);
        if (key.second.empty() || napi_get_value_double(env, args[4], &work->argument) != napi_ok) throw std::runtime_error("invalid decoder arguments");
        if (work->command != "start" && work->command != "seek" && work->command != "stop" && work->command != "remove") throw std::runtime_error("unknown decoder command");
        {
            std::lock_guard<std::mutex> guard(storeMutex);
            auto found = store.find(key);
            if (found == store.end() && work->command == "start") {
                size_t owned = 0; for (auto &item : store) if (item.first.first == owner) ++owned;
                if (owned >= 4) throw std::runtime_error("too many VideoDecoders");
                found = store.emplace(key, std::make_shared<Decoder>()).first;
            }
            if (found != store.end()) {
                work->decoder = found->second;
                ++work->decoder->pendingControls; work->tracked = true;
                if (work->command == "stop" || work->command == "remove") work->decoder->startGate.Cancel();
                work->generation = work->decoder->startGate.Capture();
                if (work->command == "remove") { work->decoder->removed = true; store.erase(found); }
            }
        }
        napi_value promise, name;
        napi_create_promise(env, &work->deferred, &promise);
        napi_create_string_utf8(env, "VideoDecoder", NAPI_AUTO_LENGTH, &name);
        auto status = napi_create_async_work(env, nullptr, name, [](napi_env, void *data) {
            auto work = static_cast<Work *>(data);
            try {
                if (!work->decoder) {
                    if (work->command == "remove") return;
                    throw std::runtime_error("decoder is not started");
                }
                std::lock_guard<std::mutex> guard(work->decoder->control);
                if (work->command == "remove") { work->decoder->Stop(); return; }
                if (work->decoder->removed) throw std::runtime_error("decoder removed");
                if (work->command == "start") {
                    if (work->argument != 0 && work->argument != 1) throw std::runtime_error("invalid mode");
                    auto dimensions = work->decoder->Start(work->source, int(work->argument), work->generation);
                    work->width = dimensions.first; work->height = dimensions.second;
                } else if (work->command == "seek") work->decoder->Seek(work->argument, work->generation);
                else work->decoder->Stop();
            } catch (const std::exception &error) { work->error = error.what(); }
        }, [](napi_env env, napi_status status, void *data) {
            std::unique_ptr<Work> work(static_cast<Work *>(data));
            napi_value result; napi_create_object(env, &result);
            if (status != napi_ok && work->error.empty()) work->error = "decoder operation cancelled";
            if (work->error.empty()) {
                if (work->command == "start") { Number(env, result, "width", work->width); Number(env, result, "height", work->height); }
                napi_resolve_deferred(env, work->deferred, result);
            } else {
                napi_value message, error; napi_create_string_utf8(env, work->error.c_str(), NAPI_AUTO_LENGTH, &message);
                napi_create_error(env, nullptr, message, &error); napi_reject_deferred(env, work->deferred, error);
            }
            napi_delete_async_work(env, work->work);
        }, work.get(), &work->work);
        if (status != napi_ok || napi_queue_async_work(env, work->work) != napi_ok) {
            if (work->work) napi_delete_async_work(env, work->work);
            throw std::runtime_error("cannot schedule decoder operation");
        }
        work.release(); return promise;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value GetFrame(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value args[2], result; napi_create_object(env, &result);
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    try {
        int32_t owner;
        if (argc < 2 || napi_get_value_int32(env, args[0], &owner) != napi_ok) throw std::runtime_error("invalid decoder arguments");
        Key key {owner, String(env, args[1])}; std::shared_ptr<Decoder> decoder;
        { std::lock_guard<std::mutex> guard(storeMutex); auto found = store.find(key); if (found != store.end()) decoder = found->second; }
        if (!decoder) return result;
        Frame frame; bool ended = false; std::string error;
        if (decoder->Next(frame, ended, error)) {
            Number(env, result, "width", frame.width); Number(env, result, "height", frame.height);
            Number(env, result, "pts", frame.pts); Number(env, result, "pkPts", frame.pts);
            napi_value data; void *bytes = nullptr;
            if (napi_create_arraybuffer(env, frame.pixels.size(), &bytes, &data) != napi_ok) throw std::runtime_error("cannot allocate decoded frame");
            memcpy(bytes, frame.pixels.data(), frame.pixels.size()); napi_set_named_property(env, result, "data", data);
        } else if (!error.empty()) Text(env, result, "error", error);
        else { napi_value eof; napi_get_boolean(env, ended, &eof); napi_set_named_property(env, result, "ended", eof); }
        return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value Dispose(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1], result; int32_t owner;
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc == 1 && napi_get_value_int32(env, args[0], &owner) == napi_ok) DisposeVideoDecoders(owner);
    napi_get_undefined(env, &result); return result;
}
} // namespace

bool TrySeekVideoDecoderForward(int owner, const std::string &id, double position) {
    std::shared_ptr<Decoder> decoder;
    { std::lock_guard<std::mutex> guard(storeMutex);
      auto found = store.find({owner, id}); if (found != store.end()) decoder = found->second; }
    return decoder && decoder->TrySeekForward(position);
}

VideoDecoderFrame ReadVideoDecoderFrame(int owner, const std::string &id) {
    std::shared_ptr<Decoder> decoder;
    {
        std::lock_guard<std::mutex> guard(storeMutex);
        auto found = store.find({owner, id});
        if (found != store.end()) decoder = found->second;
    }
    Frame frame {};
    bool ended = false;
    std::string error;
    if (decoder) decoder->Next(frame, ended, error);
    return {frame.width, frame.height, frame.pts, std::move(frame.pixels), ended, error, std::move(frame.prepared)};
}

void DisposeVideoDecoders(int owner) {
    std::vector<std::shared_ptr<Decoder>> owned;
    {
        std::lock_guard<std::mutex> guard(storeMutex);
        for (auto item = store.begin(); item != store.end();) {
            if (item->first.first != owner) { ++item; continue; }
            item->second->removed = true; item->second->startGate.Cancel();
            owned.push_back(item->second); item = store.erase(item);
        }
    }
    for (auto &decoder : owned) { std::lock_guard<std::mutex> guard(decoder->control); decoder->Stop(); }
}
void RegisterVideoDecoder(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"videoDecoderOperate", nullptr, Operate, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"videoDecoderGetFrame", nullptr, GetFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"videoDecoderDispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
