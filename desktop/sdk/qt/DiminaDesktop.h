#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QProcess>
#include <QTimer>
#include <QUrl>
#include <functional>

namespace Dimina {
struct Options {
  QString runtimePath, packagesDir, dataDir;
  int startupTimeoutMs = 30000;
};
class Desktop final : public QObject {
  Q_OBJECT
public:
  explicit Desktop(QObject *parent = nullptr);
  ~Desktop() override;
  void start(const Options &options);
  void openApp(const QString &appId, const QString &path = {},
               const QString &name = {});
  void focus(const QString &windowId);
  void closeApp(const QString &windowId);
  void closeAll();
  void importApp(const QString &absolutePath);
  void windows();
  void stop();
signals:
  void started();
  void stopped();
  void appOpened(const QJsonObject &window);
  void appOpenFailed(const QString &appId, const QString &message);
  void appImported(const QJsonObject &app);
  void windowsReceived(const QJsonArray &windows);
  void operationFailed(const QString &operation, const QString &message);

private:
  void call(const QString &method, const QJsonObject &body,
            std::function<void(QJsonValue)> success = {},
            std::function<void(QString)> failure = {}, bool get = false);
  QProcess process;
  QNetworkAccessManager network;
  QTimer startupTimer, shutdownTimer;
  QByteArray output, token, diagnostics;
  QUrl base;
  bool ready = false, stopping = false;
  quint64 generation = 0;
};
} // namespace Dimina
