using System.Net;

namespace SherlockMail.Auth;

public class ProviderProfile
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "imap";
    public string ImapHost { get; set; } = "";
    public int ImapPort { get; set; } = 993;
    public bool ImapTls { get; set; } = true;
    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 587;
    public bool SupportsOAuth { get; set; }
    public bool RequiresAppPassword { get; set; }
    public bool RequiresBridge { get; set; }
    public string[] MxPatterns { get; set; } = [];
}

public class DetectionResult
{
    public string Provider { get; set; } = "";
    public ProviderProfile Profile { get; set; } = new();
    public string Method { get; set; } = "";
    public string[]? MxRecords { get; set; }
}

public static class ProviderDetect
{
    private static readonly Dictionary<string, ProviderProfile> Profiles = new()
    {
        ["gmail"] = new ProviderProfile
        {
            Name = "Gmail / Google Workspace", Type = "gmail_api",
            ImapHost = "imap.gmail.com", ImapPort = 993, ImapTls = true,
            SmtpHost = "smtp.gmail.com", SmtpPort = 465, SupportsOAuth = true,
            MxPatterns = ["google.com", "googlemail.com", "gmail-smtp-in.l.google.com"]
        },
        ["outlook"] = new ProviderProfile
        {
            Name = "Microsoft 365 / Outlook.com", Type = "graph_api",
            ImapHost = "outlook.office365.com", ImapPort = 993, ImapTls = true,
            SmtpHost = "smtp.office365.com", SmtpPort = 587, SupportsOAuth = true,
            MxPatterns = ["outlook.com", "protection.outlook.com", "microsoft.com"]
        },
        ["yahoo"] = new ProviderProfile
        {
            Name = "Yahoo Mail", Type = "imap",
            ImapHost = "imap.mail.yahoo.com", ImapPort = 993, ImapTls = true,
            SmtpHost = "smtp.mail.yahoo.com", SmtpPort = 465, SupportsOAuth = true, RequiresAppPassword = true,
            MxPatterns = ["yahoodns.net", "yahoo.com"]
        },
        ["aol"] = new ProviderProfile
        {
            Name = "AOL Mail", Type = "imap",
            ImapHost = "imap.aol.com", ImapPort = 993, ImapTls = true,
            SmtpHost = "smtp.aol.com", SmtpPort = 465, SupportsOAuth = true, RequiresAppPassword = true,
            MxPatterns = ["yahoodns.net", "aol.com"]
        },
        ["icloud"] = new ProviderProfile
        {
            Name = "iCloud Mail", Type = "imap",
            ImapHost = "imap.mail.me.com", ImapPort = 993, ImapTls = true,
            SmtpHost = "smtp.mail.me.com", SmtpPort = 587, RequiresAppPassword = true,
            MxPatterns = ["icloud.com", "me.com", "apple.com"]
        },
        ["protonmail"] = new ProviderProfile
        {
            Name = "ProtonMail (via Bridge)", Type = "imap",
            ImapHost = "127.0.0.1", ImapPort = 1143, ImapTls = false,
            SmtpHost = "127.0.0.1", SmtpPort = 1025, RequiresBridge = true,
            MxPatterns = ["protonmail.ch", "proton.me"]
        },
        ["zoho"] = new ProviderProfile
        {
            Name = "Zoho Mail", Type = "imap",
            ImapHost = "imap.zoho.com", ImapPort = 993, ImapTls = true,
            SmtpHost = "smtp.zoho.com", SmtpPort = 465, SupportsOAuth = true,
            MxPatterns = ["zoho.com", "zohomail.com"]
        },
        ["comcast"] = new ProviderProfile
        {
            Name = "Comcast / Xfinity", Type = "imap",
            ImapHost = "imap.comcast.net", ImapPort = 993, ImapTls = true,
            SmtpHost = "smtp.comcast.net", SmtpPort = 587, RequiresAppPassword = true,
            MxPatterns = ["comcast.net"]
        }
    };

    private static readonly Dictionary<string, string> KnownDomains = new()
    {
        ["gmail.com"] = "gmail", ["googlemail.com"] = "gmail",
        ["outlook.com"] = "outlook", ["hotmail.com"] = "outlook",
        ["live.com"] = "outlook", ["msn.com"] = "outlook",
        ["yahoo.com"] = "yahoo", ["ymail.com"] = "yahoo",
        ["aol.com"] = "aol",
        ["icloud.com"] = "icloud", ["me.com"] = "icloud", ["mac.com"] = "icloud",
        ["protonmail.com"] = "protonmail", ["proton.me"] = "protonmail", ["pm.me"] = "protonmail",
        ["zoho.com"] = "zoho",
        ["comcast.net"] = "comcast", ["xfinity.com"] = "comcast"
    };

    public static async Task<DetectionResult> DetectAsync(string email)
    {
        var domain = email.Split('@').LastOrDefault()?.ToLower();
        if (string.IsNullOrEmpty(domain))
            return new DetectionResult { Provider = "unknown", Method = "invalid_email" };

        if (KnownDomains.TryGetValue(domain, out var knownProvider))
        {
            return new DetectionResult
            {
                Provider = knownProvider,
                Profile = Profiles[knownProvider],
                Method = "domain_match"
            };
        }

        try
        {
            var mxRecords = await Dns.GetHostEntryAsync(domain);
            var mxHosts = mxRecords.Aliases.Select(a => a.ToLower()).ToArray();

            foreach (var (providerKey, profile) in Profiles)
            {
                foreach (var mxHost in mxHosts)
                {
                    if (profile.MxPatterns.Any(p => mxHost.Contains(p)))
                    {
                        return new DetectionResult
                        {
                            Provider = providerKey,
                            Profile = profile,
                            Method = "mx_lookup",
                            MxRecords = mxHosts
                        };
                    }
                }
            }

            return new DetectionResult
            {
                Provider = "generic_imap",
                Profile = new ProviderProfile
                {
                    Name = $"Generic IMAP ({domain})", Type = "imap",
                    ImapHost = $"imap.{domain}", ImapPort = 993, ImapTls = true,
                    SmtpHost = $"smtp.{domain}", SmtpPort = 587
                },
                Method = "fallback",
                MxRecords = mxHosts
            };
        }
        catch
        {
            return new DetectionResult
            {
                Provider = "unknown",
                Profile = new ProviderProfile
                {
                    Name = $"Unknown Provider ({domain})", Type = "imap",
                    ImapHost = $"imap.{domain}", ImapPort = 993, ImapTls = true,
                    SmtpHost = $"smtp.{domain}", SmtpPort = 587
                },
                Method = "dns_failed"
            };
        }
    }

    public static List<object> ListProviders() =>
        Profiles.Select(kv => (object)new
        {
            key = kv.Key, name = kv.Value.Name, type = kv.Value.Type, supportsOAuth = kv.Value.SupportsOAuth
        }).ToList();
}
