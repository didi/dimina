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
    public sealed class NativeApiOptions
    {
        public string[] AppIds { get; set; } = Array.Empty<string>();
        public int TimeoutMs { get; set; } = 30000;
    }
    public sealed class NativeApiContext
    {
        public string AppId { get; internal set; } = "";
        public string WindowId { get; internal set; } = "";
        public CancellationToken CancellationToken { get; internal set; }
    }
    [DataContract]
    internal sealed class NativeRegistration
    {
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "appIds")] public string[] AppIds { get; set; } = Array.Empty<string>();
        [DataMember(Name = "timeoutMs")] public int TimeoutMs { get; set; }
    }
    [DataContract]
    internal class NativeCallHeader
    {
        [DataMember(Name = "type")] public string Type { get; set; } = "";
        [DataMember(Name = "id")] public string Id { get; set; } = "";
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "appId")] public string AppId { get; set; } = "";
        [DataMember(Name = "windowId")] public string WindowId { get; set; } = "";
    }
    [DataContract]
    internal sealed class NativeCall<T> : NativeCallHeader
    { [DataMember(Name = "params")] public T Params { get; set; } = default!; }
    [DataContract]
    internal sealed class NativeReply<T>
    {
        [DataMember(Name = "type")] public string Type { get; set; } = "native-result";
        [DataMember(Name = "id")] public string Id { get; set; } = "";
        [DataMember(Name = "value", EmitDefaultValue = false)] public T Value { get; set; } = default!;
        [DataMember(Name = "error", EmitDefaultValue = false)] public string? Error { get; set; }
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
        private volatile bool stopped, disposing;
        private readonly object disposalLock = new object();
        private Task? disposal;
        private readonly Dictionary<string, Func<byte[], NativeApiContext, Task<byte[]>>> nativeHandlers = new Dictionary<string, Func<byte[], NativeApiContext, Task<byte[]>>>();
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, CancellationTokenSource> nativeCalls = new System.Collections.Concurrent.ConcurrentDictionary<string, CancellationTokenSource>();
        private readonly SemaphoreSlim nativeWriteLock = new SemaphoreSlim(1, 1);

        private DiminaDesktop(Process process)
        {
            this.process = process;
            http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(100) };
            process.EnableRaisingEvents = true;
            process.Exited += (_, __) =>
            {
                var code = 0;
                try { code = process.ExitCode; } catch (InvalidOperationException) { }
                stopped = true; CancelNativeCalls(); exited.TrySetResult(code);
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
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
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
                _ = host.ReadNativeMessagesAsync(process.StandardOutput);
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

        public async Task RegisterApiAsync<TParams, TResult>(string name, Func<TParams, NativeApiContext, Task<TResult>> handler, NativeApiOptions? options = null, CancellationToken cancellationToken = default)
        {
            if (handler == null) throw new ArgumentNullException(nameof(handler));
            options = options ?? new NativeApiOptions();
            var synchronization = SynchronizationContext.Current;
            Func<byte[], NativeApiContext, Task<byte[]>> dispatch = async (bytes, context) =>
            {
                context.CancellationToken.ThrowIfCancellationRequested();
                var call = Deserialize<NativeCall<TParams>>(bytes);
                Task<TResult> work;
                if (synchronization == null) work = handler(call.Params, context);
                else
                {
                    var completion = new TaskCompletionSource<TResult>(TaskCreationOptions.RunContinuationsAsynchronously);
                    synchronization.Post(async _ =>
                    {
                        try { context.CancellationToken.ThrowIfCancellationRequested(); completion.TrySetResult(await handler(call.Params, context)); }
                        catch (Exception error) { completion.TrySetException(error); }
                    }, null);
                    work = completion.Task;
                }
                var value = await work.ConfigureAwait(false);
                return Serialize(new NativeReply<TResult> { Id = call.Id, Value = value });
            };
            Func<byte[], NativeApiContext, Task<byte[]>>? previous;
            lock (nativeHandlers) { nativeHandlers.TryGetValue(name, out previous); nativeHandlers[name] = dispatch; }
            try
            {
                await CallAsync<object>("registerApi", new NativeRegistration { Name = name, AppIds = options.AppIds, TimeoutMs = options.TimeoutMs }, false, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                lock (nativeHandlers)
                {
                    if (nativeHandlers.TryGetValue(name, out var current) && ReferenceEquals(current, dispatch))
                    {
                        if (previous == null) nativeHandlers.Remove(name); else nativeHandlers[name] = previous;
                    }
                }
                throw;
            }
        }

        private void CancelNativeCalls()
        {
            foreach (var pair in nativeCalls) CancelNativeToken(pair.Value);
            nativeCalls.Clear();
        }
        private static void CancelNativeToken(CancellationTokenSource source)
        {
            try { source.Cancel(); }
            catch (ObjectDisposedException) { }
            catch (AggregateException) { /* A host cancellation hook must not stop the protocol reader. */ }
        }
        private async Task ReadNativeMessagesAsync(StreamReader reader)
        {
            try
            {
                string? line;
                while ((line = await reader.ReadLineAsync().ConfigureAwait(false)) != null)
                {
                    var bytes = Encoding.UTF8.GetBytes(line);
                    NativeCallHeader call;
                    try { call = Deserialize<NativeCallHeader>(bytes); } catch (SerializationException) { continue; }
                    if (call.Type == "native-cancel")
                    {
                        if (nativeCalls.TryRemove(call.Id, out var cancellation)) CancelNativeToken(cancellation);
                    }
                    else if (call.Type == "native-call" && !stopped)
                    {
                        var cancellation = new CancellationTokenSource(); nativeCalls[call.Id] = cancellation;
                        _ = Task.Run(() => DispatchNativeAsync(bytes, call, cancellation));
                    }
                }
            }
            catch (ObjectDisposedException) { }
            catch (IOException) { }
            finally { CancelNativeCalls(); }
        }
        private async Task DispatchNativeAsync(byte[] bytes, NativeCallHeader call, CancellationTokenSource cancellation)
        {
            try
            {
                byte[] response;
                try
                {
                    Func<byte[], NativeApiContext, Task<byte[]>> handler;
                    lock (nativeHandlers) { if (!nativeHandlers.TryGetValue(call.Name, out handler)) throw new InvalidOperationException("Native API handler is unavailable"); }
                    response = await handler(bytes, new NativeApiContext { AppId = call.AppId, WindowId = call.WindowId, CancellationToken = cancellation.Token }).ConfigureAwait(false);
                }
                catch (Exception error) { response = Serialize(new NativeReply<object> { Id = call.Id, Error = error.Message }); }
                if (response.Length > 1 << 20) response = Serialize(new NativeReply<object> { Id = call.Id, Error = "Native API result exceeds 1 MiB" });
                if (cancellation.IsCancellationRequested || stopped) return;
                await nativeWriteLock.WaitAsync().ConfigureAwait(false);
                try { if (!stopped && !cancellation.IsCancellationRequested) await process.StandardInput.WriteLineAsync(Encoding.UTF8.GetString(response)).ConfigureAwait(false); }
                finally { nativeWriteLock.Release(); }
            }
            catch (IOException) { }
            catch (InvalidOperationException) { }
            finally { nativeCalls.TryRemove(call.Id, out _); cancellation.Dispose(); }
        }

        private async Task<T> CallAsync<T>(string method, object? payload, bool get, CancellationToken cancellationToken, bool allowDisposing = false)
        {
            if (stopped || (disposing && !allowDisposing)) throw new ObjectDisposedException(nameof(DiminaDesktop));
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

        public Task DisposeAsync()
        {
            lock (disposalLock)
            {
                if (disposal == null) { disposing = true; disposal = DisposeRuntimeAsync(); }
                return disposal;
            }
        }
        private async Task DisposeRuntimeAsync()
        {
            if (stopped) { http.Dispose(); process.Dispose(); return; }
            using var deadline = new CancellationTokenSource(3000);
            try { await CallAsync<object>("closeAll", new EmptyRequest(), false, deadline.Token, true).ConfigureAwait(false); }
            finally
            {
                stopped = true;
                CancelNativeCalls();
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
        private static byte[] Serialize<T>(T value)
        { using (var stream = new MemoryStream()) { new DataContractJsonSerializer(typeof(T)).WriteObject(stream, value); return stream.ToArray(); } }
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
