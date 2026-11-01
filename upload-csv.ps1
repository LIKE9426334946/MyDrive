#Requires -Version 5.1
<#
Recursively upload CSV files without changing local files.
Example:
  .\upload-csv.ps1 -LocalDirectory 'D:\runs' -ServerDirectory 'results' -ServerUrl 'http://192.168.0.150:16025'
Use -Preview to list the planned uploads without sending anything.
Token: MYDRIVE_CSV_TOKEN environment variable, -Token, or a hidden prompt.
ServerDirectory is a path INSIDE MyDrive, not a server filesystem path.
#>
[CmdletBinding()]
param(
    [string]$LocalDirectory = 'runs',
    [string]$ServerDirectory = 'results',
    [Parameter(Mandatory = $true)]
    [string]$ServerUrl,
    [string]$Token = $env:MYDRIVE_CSV_TOKEN,
    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 3600,
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'

function Get-CsvFiles {
    param([string]$Directory)
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($Directory)
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath ($pending.Pop()) -Force) {
            # Do not follow junctions/symlinks outside the chosen directory.
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($entry.PSIsContainer) {
                $pending.Push($entry.FullName)
            } elseif ($entry.Extension -ieq '.csv') {
                $entry
            }
        }
    }
}

try {
    $root = Get-Item -LiteralPath $LocalDirectory -Force
    if (-not $root.PSIsContainer -or ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'LocalDirectory must be a real directory, not a file, junction or symbolic link.'
    }
    $rootPrefix = $root.FullName.TrimEnd([char[]]'\/') + [System.IO.Path]::DirectorySeparatorChar
    $target = $ServerDirectory.Replace('\', '/').Trim('/')
    if (-not $target -or $target.Contains(':') -or @($target.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' }).Count) {
        throw 'ServerDirectory must be a MyDrive folder, such as results or results/experiment1.'
    }
    $baseUri = [Uri]$ServerUrl
    if (-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -notin @('http', 'https') -or $baseUri.UserInfo -or $baseUri.Query -or $baseUri.Fragment) {
        throw 'ServerUrl must be an HTTP(S) address without credentials, a query or a fragment.'
    }
    $endpoint = $baseUri.AbsoluteUri.TrimEnd('/') + '/api/upload/csv'
    $files = @(Get-CsvFiles -Directory $root.FullName | Sort-Object -Property FullName)
    Write-Host ('Found {0} CSV file(s) in {1}' -f $files.Count, $root.FullName)
    if ($files.Count -eq 0) { exit 0 }

    if ($Preview) {
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($rootPrefix.Length)
            $uploadName = $relative -replace '[\\/]', '_'
            Write-Host ('{0} -> {1}/{2}' -f $relative, $target, $uploadName)
        }
        Write-Host 'Preview only. No files were uploaded or changed.'
        exit 0
    }

    if ([string]::IsNullOrWhiteSpace($Token)) {
        $secureToken = Read-Host 'CSV_UPLOAD_TOKEN (input is hidden)' -AsSecureString
        $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        try {
            $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
            $secureToken.Dispose()
        }
    }
    if ([string]::IsNullOrWhiteSpace($Token)) { throw 'CSV_UPLOAD_TOKEN cannot be empty.' }
    if ($baseUri.Scheme -eq 'http') {
        Write-Warning 'HTTP does not encrypt the token or files. Use a trusted LAN/VPN or HTTPS.'
    }

    Add-Type -AssemblyName System.Net.Http
    # Keep certificate validation enabled; do not forward uploads to redirects.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token.Trim())
    $succeeded = 0
    $failed = 0
    $processed = 0

    try {
        foreach ($file in $files) {
            $processed += 1
            $relative = $file.FullName.Substring($rootPrefix.Length)
            $uploadName = $relative -replace '[\\/]', '_'
            $url = $endpoint + '?path=' + [Uri]::EscapeDataString($target) + '&filename=' + [Uri]::EscapeDataString($uploadName)
            $stream = $null
            $multipart = $null
            $request = $null
            $response = $null
            $stopBatch = $false
            try {
                Write-Host ('[{0}/{1}] {2} -> {3}/{4}' -f $processed, $files.Count, $relative, $target, $uploadName)
                $stream = [System.IO.File]::OpenRead($file.FullName)
                $multipart = [System.Net.Http.MultipartFormDataContent]::new()
                $content = [System.Net.Http.StreamContent]::new($stream)
                $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('text/csv')
                # The real UTF-8 name is URL-encoded above, avoiding legacy multipart filename encodings.
                $multipart.Add($content, 'file', 'upload.csv')
                $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $url)
                $request.Content = $multipart
                $task = $client.SendAsync($request)
                while (-not $task.IsCompleted) {
                    $percent = 0
                    if ($stream.Length -gt 0) { $percent = [Math]::Min(100, [int](100.0 * $stream.Position / $stream.Length)) }
                    Write-Progress -Activity ('CSV upload {0}/{1}' -f $processed, $files.Count) -Status $relative -PercentComplete $percent
                    Start-Sleep -Milliseconds 200
                }
                $response = $task.GetAwaiter().GetResult()
                $replyText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                $reply = $null
                try { $reply = $replyText | ConvertFrom-Json } catch { }
                if (-not $response.IsSuccessStatusCode -or $reply.status -ne 'success') {
                    $stopBatch = [int]$response.StatusCode -in @(401, 403, 503)
                    $reason = 'HTTP {0}' -f [int]$response.StatusCode
                    if ($reply.message) { $reason += ': ' + $reply.message }
                    throw $reason
                }
                $succeeded += 1
                Write-Host ('Upload success: {0} -> {1}' -f $relative, $reply.path) -ForegroundColor Green
            } catch {
                $failed += 1
                Write-Host ('Upload failed: {0} - {1}' -f $relative, $_.Exception.Message) -ForegroundColor Red
                # No automatic retries: a timed-out request may already have stored a file.
            } finally {
                Write-Progress -Activity 'CSV upload' -Completed
                if ($response) { $response.Dispose() }
                if ($request) { $request.Dispose() }
                if ($multipart) { $multipart.Dispose() }
                if ($stream) { $stream.Dispose() }
            }
            if ($stopBatch) {
                Write-Warning 'Stopped: check the server URL and CSV_UPLOAD_TOKEN before trying again.'
                break
            }
        }
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }

    Write-Host ('Finished. Success: {0}; Failed: {1}; Not attempted: {2}' -f $succeeded, $failed, ($files.Count - $processed))
    if ($failed -gt 0) { exit 1 }
    exit 0
} catch {
    Write-Host ('CSV upload stopped: {0}' -f $_.Exception.Message) -ForegroundColor Red
    exit 2
}
