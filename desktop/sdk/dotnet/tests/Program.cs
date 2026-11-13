using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using System.Threading;
using System.Text;
using System.Threading.Tasks;
using Dimina.Desktop;

internal static class Program
{
    static async Task Main(string[] args)
    {
        if (Array.IndexOf(args, "--sdk-host") >= 0)
        {
            var path = args[Array.IndexOf(args, "--data-dir") + 1];
            File.WriteAllText(Path.Combine(path, "pid"), Environment.ProcessId.ToString());
            var server = new TcpListener(IPAddress.Loopback, 0); server.Start();
            Console.WriteLine("{\"protocol\":1,\"baseUrl\":\"http://127.0.0.1:" + ((IPEndPoint)server.LocalEndpoint).Port + "/random/sdk/control/\",\"token\":\"" + new string('f', 48) + "\"}");
            // An unresponsive runtime deliberately ignores both HTTP and stdin EOF.
            while (true) { var connection = await server.AcceptTcpClientAsync(); _ = ObserveRequest(connection, path); }
        }
        var directory = Path.Combine(Path.GetTempPath(), "dimina-dotnet-" + Guid.NewGuid()); Directory.CreateDirectory(directory);
        Process? child = null;
        Task? first = null, second = null;
        try
        {
            var host = await DiminaDesktop.StartAsync(new DesktopOptions { RuntimePath = Environment.ProcessPath!, PackagesDir = directory, DataDir = directory });
            child = Process.GetProcessById(int.Parse(File.ReadAllText(Path.Combine(directory, "pid"))));
            var invoked = 0;
            await host.RegisterApiAsync<EmptyDto, EmptyDto>("scanCode", (_parameters, _context) => { invoked++; return Task.FromResult(new EmptyDto()); });
            var handlers = (Dictionary<string, Func<byte[], NativeApiContext, Task<byte[]>>>)typeof(DiminaDesktop).GetField("nativeHandlers", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(host)!;
            var context = new NativeApiContext();
            typeof(NativeApiContext).GetProperty("CancellationToken")!.SetValue(context, new CancellationToken(true));
            try { await handlers["scanCode"](Encoding.UTF8.GetBytes("{\"id\":\"cancelled\",\"params\":{}}"), context); }
            catch (OperationCanceledException) { }
            if (invoked != 0) throw new Exception("Cancelled request started its native handler");
            first = host.DisposeAsync(); second = host.DisposeAsync();
            var completed = await Task.WhenAny(first, Task.Delay(8000)) == first;
            if (!completed) throw new Exception("Runtime disposal exceeded its deadline");
            try { await first; } catch (OperationCanceledException) { /* A bounded graceful-close timeout is expected. */ }
            if (!ReferenceEquals(first, second)) throw new Exception("Concurrent disposal did not share a Task");
            if (!child.HasExited) throw new Exception("Runtime remained alive after disposal");
            if (File.ReadAllLines(Path.Combine(directory, "requests")).Length != 1) throw new Exception("Concurrent disposal sent duplicate closeAll calls");
            Console.WriteLine(".NET lifecycle: bounded shutdown, child cleanup and shared disposal passed");
        }
        finally
        {
            if (child != null) { if (!child.HasExited) child.Kill(); child.Dispose(); }
            foreach (var task in new[] { first, second }) if (task != null) { try { await task; } catch { } }
            Directory.Delete(directory, true);
        }
    }
    static async Task ObserveRequest(TcpClient connection, string directory)
    {
        using var client = connection;
        using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.UTF8, false, 1024, true);
        var request = await reader.ReadLineAsync();
        if (request == null) return;
        var length = 0;
        string? header;
        while (!string.IsNullOrEmpty(header = await reader.ReadLineAsync()))
            if (header.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) length = int.Parse(header.Substring(15).Trim());
        var body = new char[length];
        for (var read = 0; read < length;) { var count = await reader.ReadAsync(body, read, length - read); if (count == 0) return; read += count; }
        if (request.Contains("/registerApi "))
        {
            var response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"value\":null}");
            await stream.WriteAsync(response); return;
        }
        File.AppendAllText(Path.Combine(directory, "requests"), "closeAll\n");
        await Task.Delay(-1);
    }
    [DataContract] public sealed class EmptyDto { }
}
