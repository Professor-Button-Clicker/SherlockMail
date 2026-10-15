using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SherlockMail.Auth;

public class OAuthConfig
{
    public string ClientId { get; set; } = "";
    public string ClientSecret { get; set; } = "";
}

public class OAuthTokens
{
    public string AccessToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public string Email { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
}

public class GoogleOAuth
{
    private const string AuthEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";
    private const string Scope = "https://mail.google.com/ email";

    private readonly string _configDir;
    private readonly int _serverPort;
    private OAuthConfig? _config;
    private Dictionary<string, OAuthTokens> _tokens = new();
    private readonly Dictionary<string, TaskCompletionSource<OAuthTokens>> _pendingAuths = new();

    public string RedirectUri => $"http://localhost:{_serverPort}/api/oauth/google/callback";

    public GoogleOAuth(string configDir, int serverPort)
    {
        _configDir = configDir;
        _serverPort = serverPort;
        Directory.CreateDirectory(_configDir);
        LoadConfig();
        LoadTokens();
    }

    public bool IsConfigured => _config != null
        && !string.IsNullOrEmpty(_config.ClientId)
        && !string.IsNullOrEmpty(_config.ClientSecret);

    public void SaveCredentials(string clientId, string clientSecret)
    {
        _config = new OAuthConfig { ClientId = clientId, ClientSecret = clientSecret };
        var path = Path.Combine(_configDir, "oauth.json");
        File.WriteAllText(path, JsonSerializer.Serialize(new { google = _config },
            new JsonSerializerOptions { WriteIndented = true }));
    }

    public (string authUrl, string state) StartAuthFlow(string loginHint)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("OAuth not configured. Set Client ID and Secret first.");

        var state = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
        var tcs = new TaskCompletionSource<OAuthTokens>();
        _pendingAuths[state] = tcs;

        var url = $"{AuthEndpoint}?" +
            $"client_id={Uri.EscapeDataString(_config!.ClientId)}" +
            $"&redirect_uri={Uri.EscapeDataString(RedirectUri)}" +
            $"&response_type=code" +
            $"&scope={Uri.EscapeDataString(Scope)}" +
            $"&access_type=offline" +
            $"&prompt=consent" +
            $"&state={Uri.EscapeDataString(state)}" +
            (string.IsNullOrEmpty(loginHint) ? "" : $"&login_hint={Uri.EscapeDataString(loginHint)}");

        return (url, state);
    }

    public async Task<OAuthTokens> HandleCallbackAsync(string code, string state)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("OAuth not configured");

        using var http = new HttpClient();
        var response = await http.PostAsync(TokenEndpoint, new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = code,
            ["client_id"] = _config!.ClientId,
            ["client_secret"] = _config.ClientSecret,
            ["redirect_uri"] = RedirectUri,
            ["grant_type"] = "authorization_code"
        }));

        var json = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
            throw new Exception($"Token exchange failed: {json}");

        var doc = JsonDocument.Parse(json);
        var accessToken = doc.RootElement.GetProperty("access_token").GetString()!;
        var expiresIn = doc.RootElement.GetProperty("expires_in").GetInt32();
        var refreshToken = doc.RootElement.TryGetProperty("refresh_token", out var rt) ? rt.GetString() : null;

        var email = await GetEmailFromTokenAsync(http, accessToken);

        var tokens = new OAuthTokens
        {
            AccessToken = accessToken,
            RefreshToken = refreshToken ?? "",
            Email = email,
            ExpiresAt = DateTime.UtcNow.AddSeconds(expiresIn - 60)
        };

        _tokens[email.ToLower()] = tokens;
        SaveTokens();

        if (_pendingAuths.TryGetValue(state, out var tcs))
        {
            tcs.TrySetResult(tokens);
            _pendingAuths.Remove(state);
        }

        return tokens;
    }

    public async Task<string?> GetAccessTokenAsync(string email)
    {
        var key = email.ToLower();
        if (!_tokens.TryGetValue(key, out var tokens))
            return null;

        if (DateTime.UtcNow < tokens.ExpiresAt)
            return tokens.AccessToken;

        if (string.IsNullOrEmpty(tokens.RefreshToken))
            return null;

        return await RefreshTokenAsync(key);
    }

    public bool HasTokens(string email) => _tokens.ContainsKey(email.ToLower());

    public OAuthTokens? GetTokenInfo(string email)
    {
        _tokens.TryGetValue(email.ToLower(), out var t);
        return t;
    }

    public void RevokeTokens(string email)
    {
        _tokens.Remove(email.ToLower());
        SaveTokens();
    }

    private async Task<string> RefreshTokenAsync(string emailKey)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("OAuth not configured");

        var tokens = _tokens[emailKey];
        using var http = new HttpClient();
        var response = await http.PostAsync(TokenEndpoint, new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["refresh_token"] = tokens.RefreshToken,
            ["client_id"] = _config!.ClientId,
            ["client_secret"] = _config.ClientSecret,
            ["grant_type"] = "refresh_token"
        }));

        var json = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            _tokens.Remove(emailKey);
            SaveTokens();
            throw new Exception($"Token refresh failed — please sign in again: {json}");
        }

        var doc = JsonDocument.Parse(json);
        tokens.AccessToken = doc.RootElement.GetProperty("access_token").GetString()!;
        var expiresIn = doc.RootElement.GetProperty("expires_in").GetInt32();
        tokens.ExpiresAt = DateTime.UtcNow.AddSeconds(expiresIn - 60);
        SaveTokens();
        return tokens.AccessToken;
    }

    private async Task<string> GetEmailFromTokenAsync(HttpClient http, string accessToken)
    {
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        var response = await http.GetAsync("https://www.googleapis.com/oauth2/v2/userinfo");
        var json = await response.Content.ReadAsStringAsync();
        var doc = JsonDocument.Parse(json);
        return doc.RootElement.GetProperty("email").GetString() ?? "unknown";
    }

    private void LoadConfig()
    {
        var path = Path.Combine(_configDir, "oauth.json");
        if (!File.Exists(path)) return;
        try
        {
            var json = File.ReadAllText(path);
            var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("google", out var g))
            {
                _config = new OAuthConfig
                {
                    ClientId = g.GetProperty("clientId").GetString() ?? "",
                    ClientSecret = g.GetProperty("clientSecret").GetString() ?? ""
                };
            }
        }
        catch { }
    }

    private void LoadTokens()
    {
        var path = Path.Combine(_configDir, "tokens.json");
        if (!File.Exists(path)) return;
        try
        {
            var json = File.ReadAllText(path);
            _tokens = JsonSerializer.Deserialize<Dictionary<string, OAuthTokens>>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
        }
        catch { }
    }

    private void SaveTokens()
    {
        var path = Path.Combine(_configDir, "tokens.json");
        File.WriteAllText(path, JsonSerializer.Serialize(_tokens,
            new JsonSerializerOptions { WriteIndented = true }));
    }
}
