#include "DiminaDesktop.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QHostAddress>
#include <QJsonDocument>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QTextStream>
#include <QTimer>

int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  const auto arguments = app.arguments();
  if (arguments.contains("--sdk-host")) {
    const auto directory = arguments.value(arguments.indexOf("--data-dir") + 1);
    QTcpServer server;
    if (!server.listen(QHostAddress::LocalHost, 0)) return 2;
    QObject::connect(&server, &QTcpServer::newConnection, [&] {
      while (auto *socket = server.nextPendingConnection()) {
        QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, directory] {
          socket->readAll();
          if (socket->property("counted").toBool()) return;
          socket->setProperty("counted", true);
          QFile requests(directory + "/requests");
          requests.open(QIODevice::Append); requests.write("closeAll\n");
        });
      }
    });
    QTextStream output(stdout);
    output << QJsonDocument(QJsonObject{{"protocol", 1}, {"baseUrl", QString("http://127.0.0.1:%1/random/sdk/control/").arg(server.serverPort())}, {"token", QString(48, 'f')}}).toJson(QJsonDocument::Compact) << '\n';
    output.flush();
    // Deliberately ignore HTTP and stdin EOF to exercise forced termination.
    return app.exec();
  }
  QTemporaryDir directory;
  Dimina::Desktop desktop;
  QElapsedTimer elapsed;
  QObject::connect(&desktop, &Dimina::Desktop::started, [&] { elapsed.start(); desktop.stop(); desktop.stop(); });
  QObject::connect(&desktop, &Dimina::Desktop::stopped, [&] {
    QFile requests(directory.path() + "/requests");
    if (!requests.open(QIODevice::ReadOnly) || requests.readAll() != "closeAll\n") { qCritical("Duplicate or missing closeAll request"); app.exit(1); return; }
    if (elapsed.elapsed() > 5000) { qCritical("Shutdown exceeded its deadline"); app.exit(1); return; }
    qInfo("Qt lifecycle: bounded shutdown and idempotent stop passed"); app.exit(0);
  });
  QTimer::singleShot(5500, &app, [&] { qCritical("Runtime disposal exceeded its deadline"); app.exit(1); });
  desktop.start({QCoreApplication::applicationFilePath(), directory.path(), directory.path()});
  return app.exec();
}
