[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath($PSScriptRoot)
$ExpectedBranch = 'agent/finance-security-integration'
$ExpectedHead = '0da3aa124d004c60b8e5063ccbd441a1c7ecb2d9'
$Expected0020Hash = '7450BF94E27B8B5F52DFB51ACD20FE47FF51D5BB2BFF02C71C08332D251B3932'
$ProjectId = 'finance-security-integration-validation'
$ExpectedVersions0020 = @('0001','0002','0003','0004','0005','0006','0008','0009','0010','0011','0012','0013','0014','0015','0016','0017','0018','0020')
$ExpectedVersions = @($ExpectedVersions0020) + @('0021')
$SecurityMigrationName = '0021_stage1b_preflight_security_hardening.sql'
$Stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$Evidence = Join-Path $Root "validation-evidence\$Stamp"
$Lab = Join-Path ([IO.Path]::GetTempPath()) "InterExcel-Finance-Security-Validation-$Stamp"
$ReferenceLab = [IO.Path]::GetFullPath((Join-Path $Root '..\stage1b-0020-local-lab'))
$ConfigSource = Join-Path $ReferenceLab 'supabase\config.toml'
$Cli = Join-Path $ReferenceLab '.lab-tools\node_modules\@supabase\cli-windows-x64\bin\supabase.exe'
$StackAttempted = $false
$Overall = 'FAILED'
$Failure = ''
$Results = [ordered]@{
  Docker = 'NOT RUN'
  CLI = 'NOT RUN'
  Replay = 'NOT RUN'
  History = 'NOT RUN'
  Finance0020 = 'NOT RUN'
  Stage1B0021 = 'NOT RUN'
  SecurityFoundation = 'NOT RUN'
  DbLint = 'NOT RUN'
  Cleanup = 'NOT RUN'
}

function ConvertTo-SanitizedLine([string]$Line) {
  $value = $Line
  $value = $value -replace '(?i)postgres(?:ql)?://[^@\s]+@', 'postgresql://[REDACTED]@'
  $value = $value -replace '[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}', '[REDACTED-LOCAL-JWT]'
  if ($value -match '(?i)(anon key|service.role key|secret key|access token|password)\s*[:=]') {
    $value = $value -replace '([:=]).*$', '$1 [REDACTED]'
  }
  return $value
}

function Invoke-LoggedNative(
  [string]$Name,
  [string]$Executable,
  [string[]]$ArgumentList,
  [switch]$AllowFailure
) {
  $savedPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $raw = @(& $Executable @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedPreference
  }
  $lines = @($raw | ForEach-Object { ConvertTo-SanitizedLine "$_" })
  $log = Join-Path $Evidence "$Name.log"
  [IO.File]::WriteAllText($log, (($lines -join "`r`n") + "`r`n"), [Text.UTF8Encoding]::new($false))
  Write-Host "$Name`: exit $exitCode"
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "$Name failed with exit code $exitCode. See $log"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Lines = $lines; Log = $log }
}

function Invoke-Supabase([string]$Name, [string[]]$ArgumentList, [switch]$AllowFailure) {
  $joined = (' ' + ($ArgumentList -join ' ') + ' ').ToLowerInvariant()
  foreach ($blocked in @(' --linked ', ' link ', ' db push ', ' db pull ', ' migration repair ', ' --db-url ', ' functions deploy ')) {
    if ($joined.Contains($blocked)) { throw "Safety guard rejected prohibited Supabase operation: $blocked" }
  }
  return Invoke-LoggedNative $Name $Cli $ArgumentList -AllowFailure:$AllowFailure
}

function Write-Report {
  $lines = @(
    '# Finance Security Foundation - Disposable Local Validation',
    '',
    "- Timestamp: $Stamp",
    "- Repository: ``$Root``",
    "- Branch: ``$ExpectedBranch``",
    "- Baseline HEAD: ``$ExpectedHead``",
    "- Disposable project: ``$ProjectId``",
    '- Production connectivity: prohibited by command guards, cleared hosted credentials, an unlinked temporary config and local-only CLI flags.',
    '- Secrets: local keys and database credentials are redacted from saved logs.',
    '',
    '## Results',
    ''
  )
  foreach ($entry in $Results.GetEnumerator()) { $lines += "- **$($entry.Key):** $($entry.Value)" }
  $lines += @('', "- **Overall:** $Overall")
  if ($Failure) { $lines += "- **Failure:** $Failure" }
  $lines += @('', 'No Production, hosted Supabase, Vercel, migration-ledger, SQL Account or bank-account change was performed.')
  [IO.File]::WriteAllText((Join-Path $Evidence 'Local_Security_Validation_Report.md'), (($lines -join "`r`n") + "`r`n"), [Text.UTF8Encoding]::new($false))
}

try {
  New-Item -ItemType Directory -Force -Path $Evidence | Out-Null

  $branchOutput = @(& git -c "safe.directory=$Root" -C $Root branch --show-current 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Git branch verification failed: $($branchOutput -join ' ')" }
  $branch = ($branchOutput -join '').Trim()
  $headOutput = @(& git -c "safe.directory=$Root" -C $Root rev-parse HEAD 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Git HEAD verification failed: $($headOutput -join ' ')" }
  $head = ($headOutput -join '').Trim()
  if ($branch -ne $ExpectedBranch) { throw "Unexpected branch: $branch" }
  if ($head -ne $ExpectedHead) { throw "Unexpected baseline HEAD: $head" }
  if (-not (Test-Path -LiteralPath $Cli)) { throw "Pinned Supabase CLI is missing: $Cli" }
  if (-not (Test-Path -LiteralPath $ConfigSource)) { throw "Local-only Supabase config is missing: $ConfigSource" }

  $migrationFiles = @(Get-ChildItem -LiteralPath (Join-Path $Root 'supabase\migrations') -File -Filter '*.sql' | Sort-Object Name)
  if ($migrationFiles.Name -match '^0019_') { throw 'Migration 0019 is retired and must remain absent.' }
  $actualVersions = @($migrationFiles.Name | ForEach-Object { if ($_ -match '^(\d{4})_') { $Matches[1] } })
  if (($actualVersions -join '|') -ne ($ExpectedVersions -join '|')) { throw "Unexpected migration inventory: $($actualVersions -join ', ')" }
  $hash0020 = (Get-FileHash -LiteralPath (Join-Path $Root 'supabase\migrations\0020_phase2_finance_baseline_reconciliation.sql') -Algorithm SHA256).Hash
  if ($hash0020 -ne $Expected0020Hash) { throw "Authoritative 0020 hash mismatch: $hash0020" }

  $docker = Invoke-LoggedNative 'docker-info' 'docker.exe' @('info','--format','{{.ServerVersion}}|{{.OSType}}')
  if (($docker.Lines -join '') -notmatch '\|linux$') { throw 'Docker Desktop is not running in Linux-container mode.' }
  $Results.Docker = "PASS - $($docker.Lines[-1])"

  $env:SUPABASE_TELEMETRY_DISABLED = '1'
  foreach ($name in @('SUPABASE_ACCESS_TOKEN','SUPABASE_DB_PASSWORD','SUPABASE_URL','DATABASE_URL','POSTGRES_URL','VERCEL_URL')) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $cliVersion = Invoke-LoggedNative 'supabase-cli-version' $Cli @('--version')
  $Results.CLI = "PASS - $($cliVersion.Lines[0].Trim())"

  New-Item -ItemType Directory -Force -Path (Join-Path $Lab 'supabase\migrations'), (Join-Path $Lab 'supabase\tests'), (Join-Path $Lab 'held-migrations') | Out-Null
  foreach ($migration in $migrationFiles) {
    $destination = if ($migration.Name -eq $SecurityMigrationName) { Join-Path $Lab 'held-migrations' } else { Join-Path $Lab 'supabase\migrations' }
    Copy-Item -LiteralPath $migration.FullName -Destination $destination
  }
  Copy-Item -Path (Join-Path $Root 'supabase\tests\*.sql') -Destination (Join-Path $Lab 'supabase\tests')
  $config = Get-Content -LiteralPath $ConfigSource -Raw
  $config = $config -replace 'project_id\s*=\s*"[^"]+"', "project_id = `"$ProjectId`""
  foreach ($ports in @(@('54320','55320'),@('54321','55321'),@('54322','55322'),@('54323','55323'),@('54324','55324'),@('54325','55325'),@('54326','55326'),@('54327','55327'),@('54329','55329'))) {
    $config = $config -replace $ports[0], $ports[1]
  }
  $activeConfig = (($config -split "`r?`n") | Where-Object { $_.Trim() -notmatch '^#' }) -join "`n"
  if ($activeConfig -match '(?i)(https?://[^\s"'']+\.supabase\.co(?:[/:?#]|$)|[^\s"'']*pooler\.supabase\.com|gjmvqnkzhfuuntutxkio|postgres(?:ql)?://)') {
    throw 'Generated config contains an active hosted endpoint or Production identifier.'
  }
  [IO.File]::WriteAllText((Join-Path $Lab 'supabase\config.toml'), $config, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $Lab 'supabase\seed.sql'), "-- Intentionally empty disposable-local seed.`r`n", [Text.UTF8Encoding]::new($false))

  Push-Location $Lab
  try {
    $StackAttempted = $true
    Invoke-Supabase 'supabase-start' @('start') | Out-Null
    Invoke-Supabase 'migration-replay' @('db','reset','--local') | Out-Null
    $Results.Replay = 'PASS - clean local reset applied migrations through authoritative 0020'

    $containerResult = Invoke-LoggedNative 'db-container' 'docker.exe' @('ps','--filter',"name=^/supabase_db_$ProjectId$",'--format','{{.Names}}')
    $containers = @($containerResult.Lines | Where-Object { $_.Trim() })
    if ($containers.Count -ne 1) { throw 'Disposable database container was not uniquely resolved.' }
    $history = Invoke-LoggedNative 'migration-history' 'docker.exe' @('exec',$containers[0],'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c','select version from supabase_migrations.schema_migrations order by version;')
    $versions = @($history.Lines | Where-Object { $_ -match '^\d{4}$' })
    if (($versions -join '|') -ne ($ExpectedVersions0020 -join '|')) { throw "Pre-0021 migration history mismatch: $($versions -join ', ')" }

    $finance = Invoke-Supabase 'pgtap-0020-finance-66' @('test','db','--local','supabase/tests/0020_phase2_finance_baseline_reconciliation.test.sql')
    if (($finance.Lines -join "`n") -notmatch 'Result:\s*PASS' -or ($finance.Lines -join "`n") -notmatch 'Tests=66') { throw 'Finance 0020 pgTAP output was not an exact 66-test pass.' }
    $Results.Finance0020 = 'PASS - 66/66'

    Copy-Item -LiteralPath (Join-Path $Lab "held-migrations\$SecurityMigrationName") -Destination (Join-Path $Lab 'supabase\migrations')
    Invoke-Supabase 'apply-0021-local' @('migration','up','--local') | Out-Null
    $history = Invoke-LoggedNative 'migration-history-final' 'docker.exe' @('exec',$containers[0],'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c','select version from supabase_migrations.schema_migrations order by version;')
    $versions = @($history.Lines | Where-Object { $_ -match '^\d{4}$' })
    if (($versions -join '|') -ne ($ExpectedVersions -join '|')) { throw "Final migration history mismatch: $($versions -join ', ')" }
    $Results.History = 'PASS - exact 0001-0018, 0020, 0021 order'

    $stage1b = Invoke-Supabase 'pgtap-0021-stage1b-34' @('test','db','--local','supabase/tests/0021_stage1b_preflight_security_hardening.test.sql')
    if (($stage1b.Lines -join "`n") -notmatch 'Result:\s*PASS' -or ($stage1b.Lines -join "`n") -notmatch 'Tests=34') { throw 'Stage 1B 0021 pgTAP output was not an exact 34-test pass.' }
    $Results.Stage1B0021 = 'PASS - 34/34'

    $security = Invoke-Supabase 'pgtap-0021-finance-security-49' @('test','db','--local','supabase/tests/0021_finance_security_foundation.test.sql')
    if (($security.Lines -join "`n") -notmatch 'Result:\s*PASS' -or ($security.Lines -join "`n") -notmatch 'Tests=49') { throw 'Finance security pgTAP output was not an exact 49-test pass.' }
    $Results.SecurityFoundation = 'PASS - 49/49'

    Invoke-Supabase 'database-lint' @('db','lint','--local','--fail-on','error') | Out-Null
    $Results.DbLint = 'PASS - no error-level lint finding'
    $Overall = 'PASS'
  } finally {
    Pop-Location
  }
} catch {
  $Failure = $_.Exception.Message
  Write-Warning $Failure
} finally {
  if ($StackAttempted) {
    Push-Location $Lab
    try {
      $stop = Invoke-Supabase 'supabase-stop' @('stop','--project-id',$ProjectId,'--no-backup') -AllowFailure
      $Results.Cleanup = if ($stop.ExitCode -eq 0) { 'PASS - disposable stack stopped without backup' } else { "FAIL - stop exit $($stop.ExitCode)" }
    } catch {
      $Results.Cleanup = "FAIL - $($_.Exception.Message)"
    } finally {
      Pop-Location
    }
  }
  if ((Test-Path -LiteralPath $Lab) -and (-not $StackAttempted -or $Results.Cleanup -like 'PASS*')) {
    $resolvedLab = [IO.Path]::GetFullPath($Lab)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedLab.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedLab) -notlike 'InterExcel-Finance-Security-Validation-*') {
      throw "Refusing to remove unexpected path: $resolvedLab"
    }
    Remove-Item -LiteralPath $resolvedLab -Recurse -Force
  } elseif (Test-Path -LiteralPath $Lab) {
    $Results.Cleanup = "$($Results.Cleanup); temporary lab preserved for safe manual cleanup: $Lab"
  }
  Write-Report
  Write-Host "Report: $(Join-Path $Evidence 'Local_Security_Validation_Report.md')"
}

if ($Overall -ne 'PASS' -or $Results.Cleanup -notlike 'PASS*') { exit 1 }
exit 0
