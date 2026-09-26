using System.Text.Json;
using System.Text.Json.Serialization;

namespace Aml.Editor.Plugin.Viewer3D.Bridge;

/// <summary>A message from the page. Mirrors src/app/host.ts.</summary>
public sealed class PageMessage
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("url")] public string? Url { get; set; }
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("level")] public string? Level { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("summary")] public LoadSummary? Summary { get; set; }
    [JsonPropertyName("problems")] public List<string>? Problems { get; set; }
    /// <summary>For "loaded": the ticket the document was sent with.</summary>
    [JsonPropertyName("ticket")] public int? Ticket { get; set; }
}

/// <summary>What the page reports after showing a document.</summary>
public sealed class LoadSummary
{
    [JsonPropertyName("elements")] public int Elements { get; set; }
    [JsonPropertyName("files")] public int Files { get; set; }
    [JsonPropertyName("megabytes")] public int Megabytes { get; set; }
    [JsonPropertyName("triangles")] public long Triangles { get; set; }
    [JsonPropertyName("mechanisms")] public int Mechanisms { get; set; }
    [JsonPropertyName("attached")] public int Attached { get; set; }
    [JsonPropertyName("seconds")] public double Seconds { get; set; }

    public override string ToString() =>
        $"{Files} COLLADA file(s), {Megabytes} MB, {Triangles:N0} triangles, {Mechanisms} mechanism(s), {Attached} attached part(s), {Seconds:0.0} s";
}

/// <summary>The type tags on the wire, in one place on each side.</summary>
public static class MessageType
{
    // page -> host
    public const string Ready = "ready";
    public const string Loaded = "loaded";
    public const string Selected = "selected";
    public const string Log = "log";
    public const string Error = "error";

    // host -> page
    public const string Open = "open";
    public const string Select = "select";
    public const string SetTheme = "setTheme";
    public const string Clear = "clear";

    internal static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = false };
}
