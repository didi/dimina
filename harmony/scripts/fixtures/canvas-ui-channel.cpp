#include "canvas_ui_channel.h"
#include <cassert>
#include <future>
#include <iostream>
#include <thread>
#include <vector>
using namespace dimina::canvas;
struct Queue {
    std::mutex mutex; std::condition_variable cv;
    std::vector<std::unique_ptr<UiCommand>> values;
    bool reject = false; int retired = 0;
    bool Push(std::unique_ptr<UiCommand> value) {
        std::lock_guard<std::mutex> lock(mutex);
        if (reject) return false;
        values.push_back(std::move(value)); cv.notify_all(); return true;
    }
    void Wait(size_t count) {
        std::unique_lock<std::mutex> lock(mutex);
        assert(cv.wait_for(lock, std::chrono::seconds(2), [&] { return values.size() >= count; }));
    }
    std::shared_ptr<UiChannel> Channel(std::string token = "page") {
        return std::make_shared<UiChannel>(token, [this](std::unique_ptr<UiCommand> value) { return Push(std::move(value)); },
            [this] { ++retired; });
    }
};
int main(int argc, char **argv) {
    assert(argc == 2); const std::string mode = argv[1];
    Queue queue; auto channel = queue.Channel();
    if (mode == "fifo") {
        assert(channel->SendScript("before"));
        auto query = std::async(std::launch::async, [&] { return channel->Query("{\"params\":{\"operations\":[]}}", NowMs() + 2000); });
        queue.Wait(2); assert(query.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready);
        assert(channel->SendScript("after")); queue.Wait(3);
        assert(queue.values[0]->script == "before" && queue.values[0]->requestId.empty());
        assert(queue.values[1]->script.find("__diminaCanvasSync") != std::string::npos);
        assert(queue.values[2]->script == "after");
        const std::string reply = "{\"contexts\":{\"gl\":{\"resources\":[{\"metadata\":{\"created\":false}}]}},\"typedArrays\":[]}";
        channel->Complete(queue.values[1]->requestId, {reply, ""});
        assert(query.get().json == reply && channel->Pending() == 0);
    } else if (mode == "cancel") {
        auto query = std::async(std::launch::async, [&] { return channel->Query("{}", NowMs() + 2000); });
        queue.Wait(1); auto id = queue.values[0]->requestId;
        channel->Close("canvas page was replaced");
        assert(query.get().error == "canvas page was replaced");
        channel->Complete(id, {"late", ""}); assert(!channel->IsOpen() && !channel->SendScript("late"));
        assert(channel->Pending() == 0 && queue.retired == 1); channel->Close("again"); assert(queue.retired == 1);
    } else if (mode == "timeout") {
        const auto deadline = NowMs() + 60;
        auto query = std::async(std::launch::async, [&] { return channel->Query("{}", deadline); });
        queue.Wait(1);
        assert(queue.values[0]->script.find("Date.now() >= " + std::to_string(deadline)) != std::string::npos);
        assert(query.get().error == "canvas query timed out" && channel->Pending() == 0);
        channel->Complete(queue.values[0]->requestId, {"late", ""});
        assert(channel->Query("{}", NowMs() - 1).error.find("timed out") != std::string::npos);
        assert(queue.values.size() == 1);
    } else if (mode == "failed-post") {
        queue.reject = true;
        assert(channel->Query("{}", NowMs() + 2000).error == "canvas UI submission failed");
        assert(!channel->IsOpen() && channel->Pending() == 0 && queue.retired == 1);
        assert(!channel->SendScript("do not replay")); assert(queue.values.empty());
    } else if (mode == "owned") {
        std::string input = "quote\\\"\\ud800 UTF8:\xe7\x94\xbb\xe5\xb8\x83";
        input.push_back('\0'); input.append(512 * 1024, 'a'); auto expected = input;
        assert(channel->SendScript(input)); input.assign("changed after submission");
        assert(queue.values[0]->script == expected);
    } else if (mode == "budget") {
        assert(channel->Query(std::string(MAX_UI_SCRIPT_BYTES, 'x'), NowMs() + 2000).error.find("budget") != std::string::npos);
        assert(queue.values.empty() && channel->IsOpen());
    } else if (mode == "isolation") {
        Queue another; auto next = another.Channel("other");
        auto first = std::async(std::launch::async, [&] { return channel->Query("{}", NowMs() + 2000); });
        auto second = std::async(std::launch::async, [&] { return next->Query("{}", NowMs() + 2000); });
        queue.Wait(1); another.Wait(1);
        next->Complete(queue.values[0]->requestId, {"wrong page", ""});
        assert(second.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready);
        channel->Close("first closed"); assert(first.get().error == "first closed");
        next->Complete(another.values[0]->requestId, {"actual", ""}); assert(second.get().json == "actual");
    } else if (mode == "concurrent") {
        auto send = [&](const char prefix) { for (int i = 0; i < 100; i++) assert(channel->SendScript(prefix + std::to_string(i))); };
        std::thread first(send, 'a'), second(send, 'b'); first.join(); second.join(); queue.Wait(200);
        int a = 0, b = 0;
        for (auto &value : queue.values) {
            if (value->script[0] == 'a') assert(value->script == "a" + std::to_string(a++));
            else assert(value->script == "b" + std::to_string(b++));
        }
        assert(a == 100 && b == 100);
    } else assert(false);
    channel->Close("test complete"); std::cout << "PASS " << mode << '\n';
}
