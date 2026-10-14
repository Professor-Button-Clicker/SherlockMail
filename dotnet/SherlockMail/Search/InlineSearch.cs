using System.Text.RegularExpressions;

namespace SherlockMail.Search;

public class InlineSearch
{
    public List<Dictionary<string, object?>> Search(List<Dictionary<string, object?>> messages, string query)
    {
        var tokens = ParseQuery(query);
        return messages.Where(msg => MatchMessage(msg, tokens)).ToList();
    }

    private List<SearchToken> ParseQuery(string query)
    {
        var tokens = new List<SearchToken>();
        var remaining = query.Trim();

        while (remaining.Length > 0)
        {
            remaining = remaining.TrimStart();
            if (remaining.Length == 0) break;

            if (remaining.StartsWith("NOT "))
            {
                remaining = remaining[4..];
                var (token, rest) = ParseNextToken(remaining);
                token.Negated = true;
                tokens.Add(token);
                remaining = rest;
            }
            else if (remaining.StartsWith("OR "))
            {
                remaining = remaining[3..];
                if (tokens.Count > 0) tokens[^1].OrNext = true;
            }
            else if (remaining.StartsWith("AND "))
            {
                remaining = remaining[4..];
            }
            else
            {
                var (token, rest) = ParseNextToken(remaining);
                tokens.Add(token);
                remaining = rest;
            }
        }
        return tokens;
    }

    private (SearchToken Token, string Remaining) ParseNextToken(string str)
    {
        str = str.TrimStart();

        var fieldMatch = Regex.Match(str, @"^(\w+):");
        if (fieldMatch.Success)
        {
            var field = fieldMatch.Groups[1].Value.ToLower();
            str = str[fieldMatch.Length..];
            var (value, remaining) = ExtractValue(str);
            return (new SearchToken { Type = "field", Field = field, Value = value, Wildcard = value.Contains('*') || value.Contains('?') }, remaining);
        }

        if (str.StartsWith('/') && str.IndexOf('/', 1) > 0)
        {
            var end = str.IndexOf('/', 1);
            var pattern = str[1..end];
            return (new SearchToken { Type = "regex", RegexPattern = new Regex(pattern, RegexOptions.IgnoreCase) }, str[(end + 1)..]);
        }

        {
            var (value, remaining) = ExtractValue(str);
            return (new SearchToken { Type = "text", Value = value, Wildcard = value.Contains('*') || value.Contains('?') }, remaining);
        }
    }

    private (string Value, string Remaining) ExtractValue(string str)
    {
        str = str.TrimStart();
        if (str.StartsWith('"'))
        {
            var end = str.IndexOf('"', 1);
            if (end > 0) return (str[1..end], str[(end + 1)..]);
        }
        if (str.StartsWith('['))
        {
            var end = str.IndexOf(']');
            if (end > 0) return (str[..(end + 1)], str[(end + 1)..]);
        }
        var space = str.IndexOfAny([' ', '\t']);
        if (space > 0) return (str[..space], str[space..]);
        return (str, "");
    }

    private bool MatchMessage(Dictionary<string, object?> msg, List<SearchToken> tokens)
    {
        for (int i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            var match = EvaluateToken(msg, token);
            if (token.Negated) match = !match;

            if (token.OrNext && i + 1 < tokens.Count)
            {
                var nextMatch = EvaluateToken(msg, tokens[i + 1]);
                if (!match && !nextMatch) return false;
                i++;
                continue;
            }
            if (!match) return false;
        }
        return true;
    }

    private bool EvaluateToken(Dictionary<string, object?> msg, SearchToken token)
    {
        if (token.Type == "regex" && token.RegexPattern != null)
            return SearchAllFields(msg, text => token.RegexPattern.IsMatch(text));

        var value = token.Value ?? "";

        if (token.Type == "field" && token.Field != null)
        {
            var fieldValue = GetFieldValue(msg, token.Field);
            if (fieldValue == null) return false;

            if (token.Field is "sent" or "received" or "earliestdate" or "latestdate")
                return MatchDateRange(fieldValue, value);

            if (token.Field == "attachmentcount")
            {
                int.TryParse(fieldValue, out var count);
                return MatchRange(count, value);
            }

            return MatchText(fieldValue, value, token.Wildcard);
        }

        return SearchAllFields(msg, text => MatchText(text, value, token.Wildcard));
    }

    private static string? GetFieldValue(Dictionary<string, object?> msg, string field)
    {
        var map = new Dictionary<string, string>
        {
            ["from"] = "from_address", ["to"] = "to_addresses", ["cc"] = "cc_addresses",
            ["bcc"] = "bcc_addresses", ["subject"] = "subject", ["messageid"] = "message_id",
            ["attachmentcount"] = "attachment_count", ["sent"] = "date", ["received"] = "date",
            ["earliestdate"] = "date", ["latestdate"] = "date"
        };
        var dbField = map.GetValueOrDefault(field, field);
        return msg.GetValueOrDefault(dbField)?.ToString();
    }

    private static bool SearchAllFields(Dictionary<string, object?> msg, Func<string, bool> matcher)
    {
        string[] fields = ["subject", "from_address", "to_addresses", "cc_addresses", "bcc_addresses", "message_id"];
        return fields.Any(f => msg.GetValueOrDefault(f) is string val && matcher(val));
    }

    private static bool MatchText(string haystack, string needle, bool wildcard)
    {
        if (wildcard)
        {
            var pattern = "^" + Regex.Escape(needle).Replace(@"\*", ".*").Replace(@"\?", ".") + "$";
            return Regex.IsMatch(haystack, pattern, RegexOptions.IgnoreCase);
        }
        return haystack.Contains(needle, StringComparison.OrdinalIgnoreCase);
    }

    private static bool MatchDateRange(string fieldDate, string rangeStr)
    {
        var match = Regex.Match(rangeStr, @"\[(.+)\s+TO\s+(.+)\]", RegexOptions.IgnoreCase);
        if (!match.Success) return false;
        if (!DateTime.TryParse(match.Groups[1].Value.Replace('/', '-'), out var start)) return false;
        if (!DateTime.TryParse(match.Groups[2].Value.Replace('/', '-'), out var end)) return false;
        if (!DateTime.TryParse(fieldDate, out var date)) return false;
        return date >= start && date <= end;
    }

    private static bool MatchRange(int num, string rangeStr)
    {
        var match = Regex.Match(rangeStr, @"\[(\d+)\s+TO\s+(\d+)\]", RegexOptions.IgnoreCase);
        if (!match.Success) return false;
        return num >= int.Parse(match.Groups[1].Value) && num <= int.Parse(match.Groups[2].Value);
    }
}

internal class SearchToken
{
    public string Type { get; set; } = "text";
    public string? Field { get; set; }
    public string? Value { get; set; }
    public bool Negated { get; set; }
    public bool OrNext { get; set; }
    public bool Wildcard { get; set; }
    public Regex? RegexPattern { get; set; }
}
