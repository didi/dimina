#include "quickjs-debugger.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <string.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <poll.h>
#include <arpa/inet.h>
#include <errno.h>

struct js_transport_data {
    int handle;
    int (*should_cancel)(void *udata);
    void *cancel_udata;
};

static int js_transport_should_cancel(struct js_transport_data *data) {
    return data->should_cancel && data->should_cancel(data->cancel_udata);
}

static size_t js_transport_read(void *udata, char *buffer, size_t length) {
    struct js_transport_data* data = (struct js_transport_data *)udata;
    if (data->handle < 0)
        return 0;

    if (length == 0)
        return 0;

    if (buffer == NULL)
        return 0;

    struct pollfd fd = { data->handle, POLLIN, 0 };
    int poll_rc;
    do {
        if (js_transport_should_cancel(data))
            return 0;
        poll_rc = poll(&fd, 1, 100);
    } while (poll_rc == 0 || (poll_rc < 0 && errno == EINTR));
    if (poll_rc < 0 || !(fd.revents & (POLLIN | POLLHUP)))
        return 0;

    ssize_t ret = read(data->handle, (void *)buffer, length);
    if (ret < 0)
        return 0;

    if (ret == 0)
        return 0;

    if (ret > length)
        return 0;

    return ret;
}

static size_t js_transport_write(void *udata, const char *buffer, size_t length) {
    struct js_transport_data* data = (struct js_transport_data *)udata;
    if (data->handle < 0)
        return 0;

    if (length == 0)
        return 0;

    if (buffer == NULL)
        return 0;

    ssize_t ret;
#ifdef MSG_NOSIGNAL
    ret = send(data->handle, (const void *)buffer, length, MSG_NOSIGNAL);
#else
    ret = write(data->handle, (const void *)buffer, length);
#endif
    if (ret <= 0 || ret > (ssize_t) length)
        return 0;

    return ret;
}

static size_t js_transport_peek(void *udata) {
    struct pollfd fds[1];
    int poll_rc;

    struct js_transport_data* data = (struct js_transport_data *)udata;
    if (data->handle < 0)
        return 0;

    fds[0].fd = data->handle;
    fds[0].events = POLLIN;
    fds[0].revents = 0;

    poll_rc = poll(fds, 1, 0);
    if (poll_rc < 0)
        return 0;
    if (poll_rc > 1)
        return 0;
    // no data
    if (poll_rc == 0)
        return 0;
    // has data
    return 1;
}

static void js_transport_close(JSRuntime* rt, void *udata) {
    struct js_transport_data* data = (struct js_transport_data *)udata;
    if (!data)
        return;
    if (data->handle >= 0)
        close(data->handle);
    free(udata);
}

static int js_debugger_parse_sockaddr(const char* address, struct sockaddr_in *addr) {
    if (!address || !addr)
        return 0;
    const char* port_string = strrchr(address, ':');
    if (!port_string || port_string == address)
        return 0;
    char *port_end;
    long port = strtol(port_string + 1, &port_end, 10);
    if (*port_end != '\0' || port <= 0 || port > 65535)
        return 0;
    size_t host_length = (size_t)(port_string - address);
    if (host_length >= 256)
        return 0;
    char host_string[256];
    memcpy(host_string, address, host_length);
    host_string[host_length] = '\0';

    struct hostent *host = gethostbyname(host_string);
    if (!host || host->h_length > (int)sizeof(addr->sin_addr.s_addr))
        return 0;

    memset(addr, 0, sizeof(*addr));
    addr->sin_family = AF_INET;
    memcpy(&addr->sin_addr.s_addr, host->h_addr, host->h_length);
    addr->sin_port = htons((uint16_t)port);

    return 1;
}

int js_debugger_connect(JSContext *ctx, const char *address) {
    struct sockaddr_in addr;
    if (!js_debugger_parse_sockaddr(address, &addr))
        return 0;

    int client = socket(AF_INET, SOCK_STREAM, 0);
    if (client < 0)
        return 0;

    if (connect(client, (const struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(client);
        return 0;
    }

    struct js_transport_data *data = (struct js_transport_data *)malloc(sizeof(struct js_transport_data));
    if (!data) {
        close(client);
        return 0;
    }
    data->handle = client;
    data->should_cancel = NULL;
    data->cancel_udata = NULL;
    js_debugger_attach(ctx, js_transport_read, js_transport_write, js_transport_peek, js_transport_close, data);
    return 1;
}

int js_debugger_wait_connection_interruptible(JSContext *ctx, const char *address,
                                              int (*should_cancel)(void *udata), void *cancel_udata) {
    struct sockaddr_in addr;
    if (!js_debugger_parse_sockaddr(address, &addr))
        return 0;
    if (addr.sin_addr.s_addr != htonl(INADDR_LOOPBACK))
        return 0;

    int server = socket(AF_INET, SOCK_STREAM, 0);
    if (server < 0)
        return 0;

    int reuseAddress = 1;
    if (setsockopt(server, SOL_SOCKET, SO_REUSEADDR, (const char *) &reuseAddress, sizeof(reuseAddress)) < 0
        || bind(server, (struct sockaddr *) &addr, sizeof(addr)) < 0
        || listen(server, 1) < 0) {
        close(server);
        return 0;
    }

    struct pollfd server_fd = { server, POLLIN, 0 };
    int poll_rc;
    do {
        if (should_cancel && should_cancel(cancel_udata)) {
            close(server);
            return 0;
        }
        poll_rc = poll(&server_fd, 1, 100);
    } while (poll_rc == 0 || (poll_rc < 0 && errno == EINTR));
    if (poll_rc < 0 || !(server_fd.revents & POLLIN)) {
        close(server);
        return 0;
    }

    struct sockaddr_in client_addr;
    socklen_t client_addr_size = (socklen_t) sizeof(addr);
    int client = accept(server, (struct sockaddr *) &client_addr, &client_addr_size);
    close(server);
    if (client < 0)
        return 0;

    struct js_transport_data *data = (struct js_transport_data *)malloc(sizeof(struct js_transport_data));
    if (!data) {
        close(client);
        return 0;
    }
    data->handle = client;
    data->should_cancel = should_cancel;
    data->cancel_udata = cancel_udata;
    js_debugger_attach(ctx, js_transport_read, js_transport_write, js_transport_peek, js_transport_close, data);
    return 1;
}

int js_debugger_wait_connection(JSContext *ctx, const char* address) {
    return js_debugger_wait_connection_interruptible(ctx, address, NULL, NULL);
}
