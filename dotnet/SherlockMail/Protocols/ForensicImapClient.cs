using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;

namespace SherlockMail.Protocols;

public class FolderInfo
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public char Delimiter { get; set; }
    public List<string> Flags { get; set; } = [];
    public string? SpecialUse { get; set; }
    public bool Listed { get; set; } = true;
    public int Messages { get; set; }
    public int Unseen { get; set; }
}

public class FetchedMessage
{
    public uint Uid { get; set; }
    public List<string> Flags { get; set; } = [];
    public string? Subject { get; set; }
    public string? FromAddress { get; set; }
    public string? ToAddresses { get; set; }
    public string? Date { get; set; }
    public string? EnvelopeMessageId { get; set; }
    public long Size { get; set; }
    public byte[] Source { get; set; } = [];
    public DateTime? InternalDate { get; set; }
}

public class ForensicImapClient : IDisposable
{
    private readonly ImapClient _client;
    private readonly string _host;
    private readonly int _port;
    private readonly bool _useTls;
    private readonly string _email;
    private readonly string _username;
    private readonly string? _password;
    private readonly string? _appPassword;
    private readonly string? _accessToken;
    public bool IsConnected => _client.IsConnected;

    public ForensicImapClient(string host, int port, bool useTls, string email,
        string? username = null, string? password = null, string? appPassword = null,
        string? accessToken = null)
    {
        _client = new ImapClient();
        _host = host;
        _port = port;
        _useTls = useTls;
        _email = email;
        _username = username ?? email;
        _password = password;
        _appPassword = appPassword;
        _accessToken = accessToken;
    }

    public async Task ConnectAsync(CancellationToken ct = default)
    {
        var secureSocket = _useTls ? MailKit.Security.SecureSocketOptions.SslOnConnect : MailKit.Security.SecureSocketOptions.None;
        await _client.ConnectAsync(_host, _port, secureSocket, ct);

        if (_accessToken != null)
        {
            var oauth2 = new MailKit.Security.SaslMechanismOAuth2(_email, _accessToken);
            await _client.AuthenticateAsync(oauth2, ct);
        }
        else
        {
            var pass = _appPassword ?? _password ?? "";
            await _client.AuthenticateAsync(_username, pass, ct);
        }
    }

    public async Task DisconnectAsync(CancellationToken ct = default)
    {
        if (_client.IsConnected)
            await _client.DisconnectAsync(true, ct);
    }

    public async Task<List<FolderInfo>> ListFoldersAsync(CancellationToken ct = default)
    {
        var folders = new List<FolderInfo>();
        var personal = _client.GetFolder(_client.PersonalNamespaces[0]);
        await CollectFolders(personal, folders, ct);
        return folders;
    }

    private async Task CollectFolders(IMailFolder parent, List<FolderInfo> folders, CancellationToken ct)
    {
        IList<IMailFolder> children;
        try
        {
            children = await parent.GetSubfoldersAsync(false, ct);
        }
        catch { return; }

        foreach (var child in children)
        {
            var info = new FolderInfo
            {
                Path = child.FullName,
                Name = child.Name,
                Delimiter = child.DirectorySeparator,
                Flags = child.Attributes.ToString().Split(',').Select(f => f.Trim()).ToList(),
                Listed = true
            };

            var isNoselect = child.Attributes.HasFlag(FolderAttributes.NoSelect);
            if (!isNoselect)
            {
                try
                {
                    await child.StatusAsync(StatusItems.Count | StatusItems.Unread, ct);
                    info.Messages = child.Count;
                    info.Unseen = child.Unread;
                }
                catch { }
            }

            folders.Add(info);
            await CollectFolders(child, folders, ct);
        }
    }

    public async Task<(int Messages, int Unseen, uint UidNext, uint UidValidity)>
        GetFolderStatusAsync(string folderPath, CancellationToken ct = default)
    {
        var folder = await _client.GetFolderAsync(folderPath, ct);
        await folder.StatusAsync(StatusItems.Count | StatusItems.Unread | StatusItems.UidNext | StatusItems.UidValidity, ct);
        return (folder.Count, folder.Unread, folder.UidNext?.Id ?? 0, folder.UidValidity);
    }

    public async IAsyncEnumerable<FetchedMessage> FetchMessagesAsync(string folderPath,
        IList<uint>? specificUids = null, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        var folder = await _client.GetFolderAsync(folderPath, ct);
        await folder.OpenAsync(FolderAccess.ReadOnly, ct);

        try
        {
            IList<UniqueId> uids;
            if (specificUids != null && specificUids.Count > 0)
            {
                uids = specificUids.Select(u => new UniqueId(u)).ToList();
            }
            else
            {
                uids = (await folder.SearchAsync(SearchQuery.All, ct)).ToList();
            }

            foreach (var uid in uids)
            {
                if (ct.IsCancellationRequested) yield break;

                FetchedMessage? msg = null;
                try
                {
                    var mimeMessage = await folder.GetMessageAsync(uid, ct);
                    using var ms = new MemoryStream();
                    await mimeMessage.WriteToAsync(ms, ct);
                    var source = ms.ToArray();

                    var summary = await folder.FetchAsync(new[] { uid },
                        MessageSummaryItems.Flags | MessageSummaryItems.Size | MessageSummaryItems.InternalDate, ct);
                    var item = summary.FirstOrDefault();

                    msg = new FetchedMessage
                    {
                        Uid = uid.Id,
                        Source = source,
                        Subject = mimeMessage.Subject,
                        FromAddress = mimeMessage.From?.ToString(),
                        ToAddresses = mimeMessage.To?.ToString(),
                        Date = mimeMessage.Date.UtcDateTime.ToString("o"),
                        EnvelopeMessageId = mimeMessage.MessageId,
                        Size = (long)(item?.Size ?? (uint)source.Length),
                        InternalDate = item?.InternalDate?.UtcDateTime,
                        Flags = item?.Flags?.ToString().Split(',').Select(f => f.Trim()).ToList() ?? []
                    };
                }
                catch
                {
                    continue;
                }

                if (msg != null)
                    yield return msg;
            }
        }
        finally
        {
            if (folder.IsOpen)
                await folder.CloseAsync(false, ct);
        }
    }

    public async Task<FetchedMessage?> FetchMessageByUidAsync(string folderPath, uint uid, CancellationToken ct = default)
    {
        var folder = await _client.GetFolderAsync(folderPath, ct);
        await folder.OpenAsync(FolderAccess.ReadOnly, ct);

        try
        {
            var uniqueId = new UniqueId(uid);
            var mimeMessage = await folder.GetMessageAsync(uniqueId, ct);
            using var ms = new MemoryStream();
            await mimeMessage.WriteToAsync(ms, ct);
            var source = ms.ToArray();

            var summary = await folder.FetchAsync(new[] { uniqueId },
                MessageSummaryItems.Flags | MessageSummaryItems.Size | MessageSummaryItems.InternalDate, ct);
            var item = summary.FirstOrDefault();

            return new FetchedMessage
            {
                Uid = uid,
                Source = source,
                Subject = mimeMessage.Subject,
                FromAddress = mimeMessage.From?.ToString(),
                ToAddresses = mimeMessage.To?.ToString(),
                Date = mimeMessage.Date.UtcDateTime.ToString("o"),
                EnvelopeMessageId = mimeMessage.MessageId,
                Size = (long)(item?.Size ?? (uint)source.Length),
                InternalDate = item?.InternalDate?.UtcDateTime,
                Flags = item?.Flags?.ToString().Split(',').Select(f => f.Trim()).ToList() ?? []
            };
        }
        catch
        {
            return null;
        }
        finally
        {
            if (folder.IsOpen)
                await folder.CloseAsync(false, ct);
        }
    }

    public async Task<List<uint>> SearchMessagesAsync(string folderPath, SearchQuery query, CancellationToken ct = default)
    {
        var folder = await _client.GetFolderAsync(folderPath, ct);
        await folder.OpenAsync(FolderAccess.ReadOnly, ct);
        try
        {
            var uids = await folder.SearchAsync(query, ct);
            return uids.Select(u => u.Id).ToList();
        }
        finally
        {
            if (folder.IsOpen)
                await folder.CloseAsync(false, ct);
        }
    }

    public static SearchQuery BuildSearchQuery(Dictionary<string, string?> criteria)
    {
        SearchQuery? query = null;

        void And(SearchQuery q) => query = query == null ? q : query.And(q);

        if (criteria.TryGetValue("from", out var from) && from != null)
            And(SearchQuery.FromContains(from));
        if (criteria.TryGetValue("to", out var to) && to != null)
            And(SearchQuery.ToContains(to));
        if (criteria.TryGetValue("subject", out var subject) && subject != null)
            And(SearchQuery.SubjectContains(subject));
        if (criteria.TryGetValue("body", out var body) && body != null)
            And(SearchQuery.BodyContains(body));
        if (criteria.TryGetValue("text", out var text) && text != null)
            And(SearchQuery.BodyContains(text));
        if (criteria.TryGetValue("since", out var since) && since != null)
            And(SearchQuery.DeliveredAfter(DateTime.Parse(since)));
        if (criteria.TryGetValue("before", out var before) && before != null)
            And(SearchQuery.DeliveredBefore(DateTime.Parse(before)));
        if (criteria.TryGetValue("seen", out var seen) && seen == "true")
            And(SearchQuery.Seen);
        if (criteria.TryGetValue("flagged", out var flagged) && flagged == "true")
            And(SearchQuery.Flagged);

        return query ?? SearchQuery.All;
    }

    public void Dispose()
    {
        if (_client.IsConnected)
            _client.Disconnect(true);
        _client.Dispose();
    }
}
