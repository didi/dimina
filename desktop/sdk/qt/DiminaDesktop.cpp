#include "DiminaDesktop.h"
#include <QDir>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QNetworkProxy>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>
#include <QRegularExpression>
#include <exception>

namespace Dimina {
Desktop::Desktop(QObject *parent) : QObject(parent) {
  process.setParent(this);
  network.setParent(this);
  startupTimer.setParent(this);
  shutdownTimer.setParent(this);
  network.setProxy(QNetworkProxy::NoProxy);
  startupTimer.setSingleShot(true);
  shutdownTimer.setSingleShot(true);
  connect(&shutdownTimer, &QTimer::timeout, this, [this] {
    if (stopping && process.state() != QProcess::NotRunning)
      process.kill();
  });
  connect(&startupTimer, &QTimer::timeout, this, [this] {
    emit operationFailed("start", "Runtime startup timed out");
    process.kill();
  });
  connect(&process, &QProcess::readyReadStandardError, this, [this] {
    diagnostics = (diagnostics + process.readAllStandardError()).right(4096);
  });
  connect(&process, &QProcess::errorOccurred, this,
          [this](QProcess::ProcessError) {
            startupTimer.stop();
            emit operationFailed("process", process.errorString());
          });
  connect(&process, qOverload<int, QProcess::ExitStatus>(&QProcess::finished),
          this, [this](int, QProcess::ExitStatus) {
            startupTimer.stop();
            shutdownTimer.stop();
            if (!ready && !stopping)
              emit operationFailed("start", QString::fromUtf8(diagnostics));
            ready = false;
            cancelNativeCalls();
            nativeHandlers.clear();
            ++generation;
            emit stopped();
          });
  connect(&process, &QProcess::readyReadStandardOutput, this, [this] {
    output += process.readAllStandardOutput();
    if (output.size() > 2 * 1024 * 1024) {
      emit operationFailed("start", "Invalid runtime handshake");
      process.kill();
      return;
    }
    while (true) {
      const auto newline = output.indexOf('\n');
      if (newline < 0)
        return;
      const auto line = output.left(newline);
      output.remove(0, newline + 1);
      if (stopping)
        continue;
      if (ready) {
        handleNative(QJsonDocument::fromJson(line).object());
        continue;
      }
      QJsonParseError error;
      const auto hello = QJsonDocument::fromJson(line, &error).object();
      const QUrl url(hello["baseUrl"].toString());
      const auto credential = hello["token"].toString();
      if (error.error != QJsonParseError::NoError ||
          hello["protocol"].toInt() != 1 || url.scheme() != "http" ||
          url.host() != "127.0.0.1" || !url.path().endsWith("/sdk/control/") ||
          !QRegularExpression("^[a-f0-9]{48}$").match(credential).hasMatch()) {
        emit operationFailed("start", "Unsupported runtime handshake");
        process.kill();
        return;
      }
      startupTimer.stop();
      base = url;
      token = credential.toUtf8();
      ready = true;
      emit started();
    }
  });
}
Desktop::~Desktop() {
  stopping = true;
  cancelNativeCalls();
  startupTimer.stop();
  shutdownTimer.stop();
  process.closeWriteChannel();
  if (process.state() != QProcess::NotRunning &&
      !process.waitForFinished(3000)) {
    process.kill();
    process.waitForFinished(1000);
  }
}
void Desktop::start(const Options &options) {
  if (process.state() != QProcess::NotRunning) {
    emit operationFailed("start", "Runtime already started");
    return;
  }
  if (!QDir::isAbsolutePath(options.runtimePath) ||
      !QDir::isAbsolutePath(options.packagesDir) ||
      !QDir::isAbsolutePath(options.dataDir)) {
    emit operationFailed(
        "start", "runtimePath, packagesDir and dataDir must be absolute paths");
    return;
  }
  ++generation;
  shutdownTimer.stop();
  ready = false;
  stopping = false;
  output.clear();
  token.clear();
  diagnostics.clear();
  cancelNativeCalls();
  nativeHandlers.clear();
  process.setProgram(options.runtimePath);
  process.setArguments({"--sdk-host", "--packages-dir", options.packagesDir,
                        "--data-dir", options.dataDir});
  startupTimer.start(options.startupTimeoutMs);
  process.start();
}
void Desktop::call(const QString &method, const QJsonObject &body,
                   std::function<void(QJsonValue)> success,
                   std::function<void(QString)> failure, bool get) {
  const auto fail = [this, method, failure](const QString &message) {
    if (failure)
      failure(message);
    else
      emit operationFailed(method, message);
  };
  if (!ready || stopping) {
    fail("Runtime is not running");
    return;
  }
  QNetworkRequest request(base.resolved(QUrl(method)));
  request.setRawHeader("Authorization", "Bearer " + token);
  request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
  request.setTransferTimeout(100000);
  auto *reply =
      get ? network.get(request)
          : network.post(request,
                         QJsonDocument(body).toJson(QJsonDocument::Compact));
  const auto requestGeneration = generation;
  connect(reply, &QNetworkReply::finished, this,
          [this, reply, success, fail, requestGeneration] {
            if (requestGeneration != generation) {
              reply->deleteLater();
              return;
            }
            const auto bytes = reply->readAll();
            QJsonParseError parse;
            const auto envelope =
                QJsonDocument::fromJson(bytes, &parse).object();
            const auto error = envelope["error"].toString();
            if (reply->error() != QNetworkReply::NoError ||
                parse.error != QJsonParseError::NoError || !error.isEmpty())
              fail(error.isEmpty() ? reply->errorString() : error);
            else if (success)
              success(envelope["value"]);
            reply->deleteLater();
          });
}
void Desktop::openApp(const QString &appId, const QString &path,
                      const QString &name) {
  call(
      "open", {{"appId", appId}, {"path", path}, {"name", name}},
      [this](QJsonValue value) { emit appOpened(value.toObject()); },
      [this, appId](QString message) { emit appOpenFailed(appId, message); });
}
void Desktop::focus(const QString &id) { call("focus", {{"id", id}}); }
void Desktop::closeApp(const QString &id) { call("close", {{"id", id}}); }
void Desktop::closeAll() { call("closeAll", {}); }
void Desktop::importApp(const QString &path) {
  call("import", {{"path", path}},
       [this](QJsonValue value) { emit appImported(value.toObject()); });
}
void Desktop::windows() {
  call(
      "windows", {},
      [this](QJsonValue value) { emit windowsReceived(value.toArray()); }, {},
      true);
}
void Desktop::cancelNativeCalls() {
  const auto calls = nativeCalls;
  nativeCalls.clear();
  for (auto iterator = calls.constBegin(); iterator != calls.constEnd();
       ++iterator) {
    iterator.value()->store(true);
    emit nativeCallCancelled(iterator.key());
  }
}
void Desktop::registerApi(const QString &name, NativeHandler handler,
                          const QStringList &appIds, int timeoutMs) {
  if (!handler) {
    emit operationFailed("registerApi", "Native handler is required");
    return;
  }
  const auto previous = nativeHandlers.value(name);
  const auto current = std::make_shared<NativeHandler>(std::move(handler));
  nativeHandlers.insert(name, current);
  call(
      "registerApi",
      {{"name", name},
       {"appIds", QJsonArray::fromStringList(appIds)},
       {"timeoutMs", timeoutMs}},
      [this, name](QJsonValue) { emit nativeApiRegistered(name); },
      [this, name, previous, current](QString error) {
        if (nativeHandlers.value(name) == current) {
          if (previous)
            nativeHandlers.insert(name, previous);
          else
            nativeHandlers.remove(name);
        }
        emit operationFailed("registerApi", error);
      });
}
void Desktop::handleNative(const QJsonObject &message) {
  const auto type = message["type"].toString(), id = message["id"].toString();
  if (type == "native-cancel") {
    if (auto cancelled = nativeCalls.take(id)) {
      cancelled->store(true);
      emit nativeCallCancelled(id);
    }
    return;
  }
  if (type != "native-call" || !ready || stopping)
    return;
  const auto cancelled = std::make_shared<std::atomic_bool>(false);
  nativeCalls.insert(id, cancelled);
  const auto epoch = generation;
  QPointer<Desktop> guard(this);
  NativeReply reply = [guard, epoch, id, cancelled](QJsonObject value,
                                                    QString error) {
    if (!guard || cancelled->load())
      return;
    QMetaObject::invokeMethod(guard, [guard, epoch, id, cancelled, value,
                                      error] {
      if (!guard || guard->generation != epoch || !guard->ready ||
          guard->stopping || cancelled->load() ||
          !guard->nativeCalls.contains(id))
        return;
      guard->nativeCalls.remove(id);
      QJsonObject result{{"type", "native-result"}, {"id", id}};
      if (error.isEmpty())
        result["value"] = value;
      else
        result["error"] = error;
      auto bytes = QJsonDocument(result).toJson(QJsonDocument::Compact);
      if (bytes.size() > 1024 * 1024)
        bytes = QJsonDocument(
                    QJsonObject{{"type", "native-result"},
                                {"id", id},
                                {"error", "Native API result exceeds 1 MiB"}})
                    .toJson(QJsonDocument::Compact);
      guard->process.write(bytes + '\n');
    });
  };
  const auto handler = nativeHandlers.value(message["name"].toString());
  if (!handler) {
    reply({}, "Native API handler is unavailable");
    return;
  }
  try {
    (*handler)(message["params"].toObject(),
               {message["appId"].toString(), message["windowId"].toString(), id,
                cancelled},
               reply);
  } catch (const std::exception &error) {
    reply({}, QString::fromUtf8(error.what()));
  } catch (...) {
    reply({}, "Native API handler failed");
  }
}
void Desktop::stop() {
  if (process.state() == QProcess::NotRunning || stopping)
    return;
  // Bound shutdown from the first stop request, including an unresponsive
  // control server. Do not wait for the normal 100-second request timeout.
  const auto closeInput = [this] { process.closeWriteChannel(); };
  if (ready)
    call("closeAll", {}, [closeInput](QJsonValue) { closeInput(); },
         [closeInput](QString) { closeInput(); });
  else
    closeInput();
  stopping = true;
  startupTimer.stop();
  cancelNativeCalls();
  shutdownTimer.start(3000);
}
} // namespace Dimina
