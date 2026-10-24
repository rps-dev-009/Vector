param([Parameter(Mandatory = $true)][string]$Manifest, [switch]$Cleanup)
$ErrorActionPreference = 'Stop'
$output = Split-Path -Parent $Manifest
$allowed = 'C:\Users\hp\AppData\Local\Temp\kilo\'
if (-not [IO.Path]::GetFullPath($Manifest).StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest must be in approved temp directory' }
$receipt = Join-Path $output 'owned-word.json'
if ($Cleanup) {
    if (Test-Path -LiteralPath $receipt) {
        $owned = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
        $process = Get-Process -Id $owned.pid -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -eq 'WINWORD' -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $owned.startTicks) {
            Stop-Process -Id $process.Id -ErrorAction Stop
        }
    }
    exit 0
}
$existing = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$createdAfter = Get-Date
$word = $null
$document = $null
$ownedInstance = $false
$rows = @()
try {
    $word = New-Object -ComObject Word.Application
    # Word.Application has no Hwnd before a document window exists. Require exactly
    # one newly created automation process, never a user or pre-existing instance.
    $created = @(Get-CimInstance Win32_Process -Filter "Name = 'WINWORD.EXE'" | Where-Object {
        $existing -notcontains $_.ProcessId -and $_.CreationDate -ge $createdAfter -and $_.CommandLine -match '/Automation -Embedding'
    })
    if ($created.Count -ne 1) { throw 'Cannot identify a unique newly created Word automation instance' }
    $wordPid = $created[0].ProcessId
    $process = Get-Process -Id $wordPid
    $ownedInstance = $true
    @{ pid = $wordPid; startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
    $word.AutomationSecurity = 3
    $word.DisplayAlerts = 0
    $word.Visible = $false
    $version = @{ version = $word.Version; build = $word.Build; pid = $wordPid }
    $tests = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
    foreach ($entry in $tests.entries) {
        if (-not [IO.Path]::GetFullPath($entry.path).StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Word may only open temp artifacts' }
        $range = $null
        $find = $null
        try {
            # Open read-only, without conversion prompts or recent-file registration.
            $document = $word.Documents.Open($entry.path, $false, $true, $false)
            $document.ActiveWindow.View.Type = 3
            $document.Repaginate()
            $row = @{ id = $entry.id; variant = $entry.variant; pages = $document.ComputeStatistics(2); marker = $null }
            if ($entry.marker) {
                $range = $document.Content
                $find = $range.Find
                $find.ClearFormatting()
                $find.Text = $entry.marker
                $find.Forward = $true
                $find.Wrap = 0
                $find.MatchWildcards = $false
                if (-not $find.Execute()) { throw "Marker missing: $($entry.marker)" }
                $range.Collapse(1)
                $row.marker = @{ page = $range.Information(3); yPt = $range.Information(6) }
                if ($row.marker.yPt -lt 0) { throw "Word did not expose marker layout: $($entry.marker)" }
            }
            $rows += $row
            Write-Output ("Word: {0}/{1}: {2} pages {3}" -f $entry.id, $entry.variant, $row.pages, ($row.marker | ConvertTo-Json -Compress))
        } finally {
            if ($find) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($find) }
            if ($range) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($range) }
            if ($document) { try { $document.Close(0) } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document); $document = $null } }
        }
    }
    @{ word = $version; entries = $rows } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'word-results.json') -Encoding UTF8
} finally {
    if ($word) {
        try { if ($ownedInstance) { $noSave = 0; $word.Quit([ref]$noSave) } }
        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
