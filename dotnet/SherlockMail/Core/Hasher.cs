using System.Security.Cryptography;

namespace SherlockMail.Core;

public static class Hasher
{
    public static readonly string[] SupportedAlgorithms = ["md5", "sha1", "sha256", "sha512"];

    public static string HashBuffer(byte[] buffer, string algorithm = "sha256")
    {
        using var hasher = CreateHashAlgorithm(algorithm);
        var hash = hasher.ComputeHash(buffer);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static string HashString(string input, string algorithm = "sha256")
    {
        return HashBuffer(System.Text.Encoding.UTF8.GetBytes(input), algorithm);
    }

    public static async Task<string> HashFileAsync(string filePath, string algorithm = "sha256")
    {
        using var hasher = CreateHashAlgorithm(algorithm);
        await using var stream = File.OpenRead(filePath);
        var hash = await hasher.ComputeHashAsync(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static Dictionary<string, string> HashMultiple(byte[] buffer, string[] algorithms)
    {
        var results = new Dictionary<string, string>();
        foreach (var alg in algorithms)
        {
            using var hasher = CreateHashAlgorithm(alg);
            var hash = hasher.ComputeHash(buffer);
            results[alg] = Convert.ToHexString(hash).ToLowerInvariant();
        }
        return results;
    }

    public static async Task<(bool Valid, string Expected, string Actual, string Algorithm)>
        VerifyFileHashAsync(string filePath, string expectedHash, string algorithm = "sha256")
    {
        var actual = await HashFileAsync(filePath, algorithm);
        var expected = expectedHash.ToLowerInvariant();
        return (actual == expected, expected, actual, algorithm);
    }

    private static HashAlgorithm CreateHashAlgorithm(string algorithm)
    {
        return algorithm.ToLowerInvariant() switch
        {
            "md5" => MD5.Create(),
            "sha1" => SHA1.Create(),
            "sha256" => SHA256.Create(),
            "sha512" => SHA512.Create(),
            _ => throw new ArgumentException($"Unsupported hash algorithm: {algorithm}")
        };
    }
}
