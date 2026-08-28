#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <uv.h>

enum {
    DIMINA_TEST_OK = 0,
    DIMINA_TEST_LOOP_INIT_FAILED = 10,
    DIMINA_TEST_ASYNC_INIT_FAILED = 11,
    DIMINA_TEST_TIMER_INIT_FAILED = 12,
    DIMINA_TEST_TIMER_START_FAILED = 13,
    DIMINA_TEST_THREAD_CREATE_FAILED = 14,
    DIMINA_TEST_LOOP_RUN_FAILED = 15,
    DIMINA_TEST_THREAD_JOIN_FAILED = 16,
    DIMINA_TEST_ASYNC_SEND_FAILED = 17,
    DIMINA_TEST_ASYNC_CALLBACK_MISSING = 18,
    DIMINA_TEST_WATCHDOG_FIRED = 19,
    DIMINA_TEST_CLOSE_CALLBACK_MISMATCH = 20,
    DIMINA_TEST_LOOP_STILL_ALIVE = 21,
    DIMINA_TEST_LOOP_CLOSE_FAILED = 22,
};

typedef struct {
    uv_loop_t loop;
    uv_async_t async;
    uv_timer_t watchdog;
    uv_thread_t worker;
    int async_initialized;
    int watchdog_initialized;
    int send_result;
    unsigned int async_callbacks;
    unsigned int close_callbacks;
    int watchdog_fired;
} DiminaLibuvLifecycle;

static void dimina_on_close(uv_handle_t *handle) {
    DiminaLibuvLifecycle *lifecycle = handle->loop->data;
    lifecycle->close_callbacks++;
}

static void dimina_close_handle(uv_handle_t *handle) {
    if (!uv_is_closing(handle)) {
        uv_close(handle, dimina_on_close);
    }
}

static void dimina_on_async(uv_async_t *handle) {
    DiminaLibuvLifecycle *lifecycle = handle->loop->data;
    lifecycle->async_callbacks++;

    dimina_close_handle((uv_handle_t *)&lifecycle->async);
    if (lifecycle->watchdog_initialized) {
        uv_timer_stop(&lifecycle->watchdog);
        dimina_close_handle((uv_handle_t *)&lifecycle->watchdog);
    }
}

static void dimina_on_watchdog(uv_timer_t *handle) {
    DiminaLibuvLifecycle *lifecycle = handle->loop->data;
    lifecycle->watchdog_fired = 1;

    dimina_close_handle((uv_handle_t *)&lifecycle->watchdog);
    /* Stop polling, then let the loop thread close async after joining its sender. */
    uv_stop(&lifecycle->loop);
}

static void dimina_send_async(void *argument) {
    DiminaLibuvLifecycle *lifecycle = argument;

    /* Let uv_run enter its polling phase before waking it from this thread. */
    uv_sleep(1);
    lifecycle->send_result = uv_async_send(&lifecycle->async);
}

static void dimina_cleanup_initialized_handles(DiminaLibuvLifecycle *lifecycle) {
    if (lifecycle->async_initialized) {
        dimina_close_handle((uv_handle_t *)&lifecycle->async);
    }
    if (lifecycle->watchdog_initialized) {
        uv_timer_stop(&lifecycle->watchdog);
        dimina_close_handle((uv_handle_t *)&lifecycle->watchdog);
    }
    uv_run(&lifecycle->loop, UV_RUN_DEFAULT);
}

static int dimina_report_uv_error(unsigned int iteration, const char *operation, int error_code, int test_code) {
    fprintf(stderr, "FAIL iteration=%u operation=%s libuv=%s (%d)\n", iteration, operation, uv_strerror(error_code),
            error_code);
    return test_code;
}

static int dimina_run_lifecycle(unsigned int iteration) {
    DiminaLibuvLifecycle lifecycle;
    memset(&lifecycle, 0, sizeof(lifecycle));

    int result = uv_loop_init(&lifecycle.loop);
    if (result != 0) {
        return dimina_report_uv_error(iteration, "uv_loop_init", result, DIMINA_TEST_LOOP_INIT_FAILED);
    }
    lifecycle.loop.data = &lifecycle;

    result = uv_async_init(&lifecycle.loop, &lifecycle.async, dimina_on_async);
    if (result != 0) {
        uv_loop_close(&lifecycle.loop);
        return dimina_report_uv_error(iteration, "uv_async_init", result, DIMINA_TEST_ASYNC_INIT_FAILED);
    }
    lifecycle.async_initialized = 1;

    result = uv_timer_init(&lifecycle.loop, &lifecycle.watchdog);
    if (result != 0) {
        dimina_cleanup_initialized_handles(&lifecycle);
        uv_loop_close(&lifecycle.loop);
        return dimina_report_uv_error(iteration, "uv_timer_init", result, DIMINA_TEST_TIMER_INIT_FAILED);
    }
    lifecycle.watchdog_initialized = 1;

    result = uv_timer_start(&lifecycle.watchdog, dimina_on_watchdog, 1000, 0);
    if (result != 0) {
        dimina_cleanup_initialized_handles(&lifecycle);
        uv_loop_close(&lifecycle.loop);
        return dimina_report_uv_error(iteration, "uv_timer_start", result, DIMINA_TEST_TIMER_START_FAILED);
    }

    result = uv_thread_create(&lifecycle.worker, dimina_send_async, &lifecycle);
    if (result != 0) {
        dimina_cleanup_initialized_handles(&lifecycle);
        uv_loop_close(&lifecycle.loop);
        return dimina_report_uv_error(iteration, "uv_thread_create", result, DIMINA_TEST_THREAD_CREATE_FAILED);
    }
    result = uv_run(&lifecycle.loop, UV_RUN_DEFAULT);
    int join_result = uv_thread_join(&lifecycle.worker);

    if (result != 0 && join_result == 0) {
        dimina_cleanup_initialized_handles(&lifecycle);
    }
    if (join_result != 0) {
        uv_loop_close(&lifecycle.loop);
        return dimina_report_uv_error(iteration, "uv_thread_join", join_result, DIMINA_TEST_THREAD_JOIN_FAILED);
    }
    if (lifecycle.send_result != 0) {
        uv_loop_close(&lifecycle.loop);
        return dimina_report_uv_error(iteration, "uv_async_send", lifecycle.send_result, DIMINA_TEST_ASYNC_SEND_FAILED);
    }
    if (lifecycle.watchdog_fired) {
        fprintf(stderr, "FAIL iteration=%u watchdog fired before async wake-up\n", iteration);
        uv_loop_close(&lifecycle.loop);
        return DIMINA_TEST_WATCHDOG_FIRED;
    }
    if (result != 0) {
        uv_loop_close(&lifecycle.loop);
        return dimina_report_uv_error(iteration, "uv_run", result, DIMINA_TEST_LOOP_RUN_FAILED);
    }
    if (lifecycle.async_callbacks != 1) {
        fprintf(stderr, "FAIL iteration=%u async_callbacks=%u expected=1\n", iteration, lifecycle.async_callbacks);
        uv_loop_close(&lifecycle.loop);
        return DIMINA_TEST_ASYNC_CALLBACK_MISSING;
    }
    if (lifecycle.close_callbacks != 2) {
        fprintf(stderr, "FAIL iteration=%u close_callbacks=%u expected=2\n", iteration, lifecycle.close_callbacks);
        uv_loop_close(&lifecycle.loop);
        return DIMINA_TEST_CLOSE_CALLBACK_MISMATCH;
    }
    if (uv_loop_alive(&lifecycle.loop)) {
        fprintf(stderr, "FAIL iteration=%u loop still has active handles\n", iteration);
        uv_loop_close(&lifecycle.loop);
        return DIMINA_TEST_LOOP_STILL_ALIVE;
    }

    result = uv_loop_close(&lifecycle.loop);
    if (result != 0) {
        return dimina_report_uv_error(iteration, "uv_loop_close", result, DIMINA_TEST_LOOP_CLOSE_FAILED);
    }

    return DIMINA_TEST_OK;
}

int main(int argc, char **argv) {
    unsigned long iteration_count = 64;
    if (argc == 2) {
        char *end = NULL;
        iteration_count = strtoul(argv[1], &end, 10);
        if (end == argv[1] || *end != '\0' || iteration_count == 0 || iteration_count > 10000) {
            fprintf(stderr, "usage: %s [iterations: 1..10000]\n", argv[0]);
            return 2;
        }
    } else if (argc > 2) {
        fprintf(stderr, "usage: %s [iterations: 1..10000]\n", argv[0]);
        return 2;
    }

    printf("Dimina libuv lifecycle test: version=%s iterations=%lu\n", uv_version_string(), iteration_count);
    for (unsigned long iteration = 1; iteration <= iteration_count; iteration++) {
        int result = dimina_run_lifecycle((unsigned int)iteration);
        if (result != DIMINA_TEST_OK) {
            return result;
        }
    }

    printf("PASS: %lu loop/async/close lifecycle iterations\n", iteration_count);
    return DIMINA_TEST_OK;
}
