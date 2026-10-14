using System.Security.Cryptography.X509Certificates;

namespace SherlockMail.Licensing;

public class LicenseInfo
{
    public bool IsValid { get; set; }
    public string? LicensedTo { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public string? Edition { get; set; }
    public string? Message { get; set; }
}

public static class CertificateLicensing
{
    public static LicenseInfo ValidateLicense(string? certificatePath = null)
    {
        if (string.IsNullOrEmpty(certificatePath) || !File.Exists(certificatePath))
        {
            return new LicenseInfo
            {
                IsValid = true,
                LicensedTo = "Community Edition",
                Edition = "Community",
                Message = "No license certificate found. Running in Community Edition mode."
            };
        }

        try
        {
            var cert = new X509Certificate2(certificatePath);

            return new LicenseInfo
            {
                IsValid = cert.NotAfter > DateTime.UtcNow,
                LicensedTo = cert.Subject,
                ExpiresAt = cert.NotAfter,
                Edition = "Professional",
                Message = cert.NotAfter > DateTime.UtcNow
                    ? $"Licensed to {cert.Subject}, expires {cert.NotAfter:yyyy-MM-dd}"
                    : "License certificate has expired."
            };
        }
        catch (Exception ex)
        {
            return new LicenseInfo
            {
                IsValid = false,
                Message = $"Invalid license certificate: {ex.Message}"
            };
        }
    }
}
