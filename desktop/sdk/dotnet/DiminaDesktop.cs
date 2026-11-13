using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Dimina.Desktop
{
    public sealed class DesktopOptions
    {
        public string RuntimePath { get; set; } = "";
        public string PackagesDir { get; set; } = "";
        public string DataDir { get; set; } = "";
        public int StartupTimeoutMs { get; set; } = 30000;
        public Action<string>? OnLog { get; set; }
    }

    [DataContract]
    public sealed class OpenAppOptions
    {
        [DataMember(Name = "appId")] public string AppId { get; set; } = "";
        [DataMember(Name = "path", EmitDefaultValue = false)] public string? Path { get; set; }
        [DataMember(Name = "name", EmitDefaultValue = false)] public string? Name { get; set; }
    }
    [DataContract]
    public sealed class WindowInfo
    {
        [DataMember(Name = "id")] public string Id { get; set; } = "";
        [DataMember(Name = "appId")] public string AppId { get; set; } = "";
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "ready")] public bool Ready { get; set; }
    }
    [DataContract]
    public sealed class ImportedApp
    {
        [DataMember(Name = "appId")] public string AppId { get; set; } = "";
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "path")] public string Path { get; set; } = "";
        [DataMember(Name = "imported")] public bool Imported { get; set; }
    }
    [DataContract]
    internal sealed class Handshake
    {
        [DataMember(Name = "protocol")] public int Protocol { get; set; }
        [DataMember(Name = "baseUrl")] public string BaseUrl { get; set; } = "";
        [DataMember(Name = "token")] public string Token { get; set; } = "";
    }
    [DataContract]
    internal sealed class Envelope<T>
    {
        [DataMember(Name = "value")] public T? Value { get; set; }
        [DataMember(Name = "error")] public string? Error { get; set; }
    }
    [DataContract] internal sealed class IdRequest { [DataMember(Name = "id")] public string Id { get; set; } = ""; }
    [DataContract] internal sealed class PathRequest { [DataMember(Name = "path")] public string Path { get; set; } = ""; }
    [DataContract] internal sealed class EmptyRequest { }

    public sealed class DiminaDesktop : IDisposable
    {
        private readonly Process process;
        private readonly HttpClient http;
        private readonly TaskCompletionSource<int> exited = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        private Uri baseUri = null!;
        private string token = "";
        private volatile bool stopped;

        private DiminaDesktop(Process process)
        {
            this.process = process;
            http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(100) };
            process.EnableRaisingEvents = true;
            process.Exited += (_, __) => {
                var code = 0;
                try { code = process.ExitCode; } catch (InvalidOperationException) { }
                stopped = true; exited.TrySetResult(code);
            };
        }

        public static async Task<DiminaDesktop> StartAsync(DesktopOptions options, CancellationToken cancellationToken = default)
        {
            foreach (var path in new[] { options.RuntimePath, options.PackagesDir, options.DataDir })
                if (string.IsNullOrEmpty(path) || !System.IO.Path.IsPathRooted(path))
                    throw new ArgumentException("RuntimePath, PackagesDir and DataDir must be absolute paths");
            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = options.RuntimePath,
                    Arguments = "--sdk-host --packages-dir " + Quote(options.PackagesDir) + " --data-dir " + Quote(options.DataDir),
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                }
            };
            var host = new DiminaDesktop(process);
            var diagnostics = new StringBuilder();
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data == null) return;
                lock (diagnostics) { diagnostics.AppendLine(e.Data); if (diagnostics.Length > 4096) diagnostics.Remove(0, diagnostics.Length - 4096); }
                try { options.OnLog?.Invoke(e.Data); } catch { /* Host logging must not terminate the runtime client. */ }
            };
            try
            {
                process.Start(); process.BeginErrorReadLine();
                var line = process.StandardOutput.ReadLineAsync();
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    var delay = Task.Delay(options.StartupTimeoutMs, timeout.Token);
                    if (await Task.WhenAny(line, delay).ConfigureAwait(false) != line)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        throw new TimeoutException("Dimina runtime startup timed out");
                    }
                    timeout.Cancel();
                }
                var text = await line.ConfigureAwait(false);
                if (text == null) { lock (diagnostics) throw new InvalidOperationException("Dimina runtime exited: " + diagnostics); }
                var hello = Deserialize<Handshake>(Encoding.UTF8.GetBytes(text));
                var uri = new Uri(hello.BaseUrl);
                if (hello.Protocol != 1 || uri.Scheme != "http" || uri.Host != "127.0.0.1" || !uri.AbsolutePath.EndsWith("/sdk/control/", StringComparison.Ordinal) || !Regex.IsMatch(hello.Token, "^[a-f0-9]{48}$"))
                    throw new InvalidOperationException("Unsupported Dimina runtime handshake");
                host.baseUri = uri; host.token = hello.Token;
                _ = DrainOutputAsync(process.StandardOutput);
                return host;
            }
            catch
            {
                try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { }
                host.http.Dispose(); process.Dispose(); throw;
            }
        }

        public Task<WindowInfo> OpenAppAsync(OpenAppOptions options, CancellationToken cancellationToken = default)
            => CallAsync<WindowInfo>("open", options, false, cancellationToken);
        public async Task FocusAsync(string id, CancellationToken cancellationToken = default)
            { await CallAsync<object>("focus", new IdRequest { Id = id }, false, cancellationToken).ConfigureAwait(false); }
        public async Task CloseAppAsync(string id, CancellationToken cancellationToken = default)
            { await CallAsync<object>("close", new IdRequest { Id = id }, false, cancellationToken).ConfigureAwait(false); }
        public async Task CloseAllAsync(CancellationToken cancellationToken = default)
            { await CallAsync<object>("closeAll", new EmptyRequest(), false, cancellationToken).ConfigureAwait(false); }
        public Task<List<WindowInfo>> WindowsAsync(CancellationToken cancellationToken = default)
            => CallAsync<List<WindowInfo>>("windows", null, true, cancellationToken);
        public Task<ImportedApp> ImportAppAsync(string absolutePath, CancellationToken cancellationToken = default)
            => CallAsync<ImportedApp>("import", new PathRequest { Path = absolutePath }, false, cancellationToken);

        private async Task<T> CallAsync<T>(string method, object? payload, bool get, CancellationToken cancellationToken)
        {
            if (stopped) throw new ObjectDisposedException(nameof(DiminaDesktop));
            using (var request = new HttpRequestMessage(get ? HttpMethod.Get : HttpMethod.Post, new Uri(baseUri, method)))
            {
                request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
                if (!get)
                {
                    using (var stream = new MemoryStream())
                    {
                        var body = payload ?? new EmptyRequest();
                        new DataContractJsonSerializer(body.GetType()).WriteObject(stream, body);
                        request.Content = new ByteArrayContent(stream.ToArray());
                        request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
                    }
                }
                using (var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false))
                {
                    var body = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                    Envelope<T> envelope;
                    try { envelope = Deserialize<Envelope<T>>(body); }
                    catch (SerializationException e) { throw new InvalidOperationException("Invalid runtime response (HTTP " + (int)response.StatusCode + ")", e); }
                    if (!response.IsSuccessStatusCode || !string.IsNullOrEmpty(envelope.Error))
                        throw new InvalidOperationException(envelope.Error ?? "Runtime HTTP " + (int)response.StatusCode);
                    return envelope.Value!;
                }
            }
        }

        public async Task DisposeAsync()
        {
            if (stopped) { http.Dispose(); process.Dispose(); return; }
            try { await CloseAllAsync().ConfigureAwait(false); }
            finally
            {
                stopped = true;
                try { process.StandardInput.Close(); } catch (InvalidOperationException) { }
                if (await Task.WhenAny(exited.Task, Task.Delay(3000)).ConfigureAwait(false) != exited.Task)
                { try { process.Kill(); } catch (InvalidOperationException) { } }
                await Task.WhenAny(exited.Task, Task.Delay(1000)).ConfigureAwait(false);
                http.Dispose(); process.Dispose();
            }
        }
        public void Dispose() => DisposeAsync().GetAwaiter().GetResult();

        private static T Deserialize<T>(byte[] bytes)
        {
            using (var stream = new MemoryStream(bytes)) return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream)!;
        }
        private static async Task DrainOutputAsync(StreamReader reader)
        {
            try { while (await reader.ReadLineAsync().ConfigureAwait(false) != null) { } }
            catch (ObjectDisposedException) { }
            catch (IOException) { }
        }
        private static string Quote(string text)
        {
            var result = new StringBuilder("\""); var slashes = 0;
            foreach (var character in text)
            {
                if (character == '\\') { slashes++; continue; }
                result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(character);
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
    }
}
