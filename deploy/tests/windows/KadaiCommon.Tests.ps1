# Pester 5 tests for deploy/onprem/windows/kadai-common.ps1 (platform-independent helpers).
#   Invoke-Pester -Path deploy/tests/windows -Output Detailed

BeforeAll {
  . (Join-Path $PSScriptRoot '..\..\onprem\windows\kadai-common.ps1')
  $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("kadai-pester-" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $script:Tmp | Out-Null
}

AfterAll {
  Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Read-EnvFile' {
  It 'parses plain, quoted, exported and empty values; ignores comments' {
    $f = Join-Path $script:Tmp 'a.env'
    Write-Utf8File -Path $f -Lines @(
      '# comment', 'PLAIN=value', 'SPACES=Kadai <no-reply@localhost>', 'QUOTED="double quoted"',
      "SINGLE='single'", 'EMPTY=', 'export EXPORTED=yes', 'DATA=C:\ProgramData\Kadai\data', 'DUP=1', 'DUP=2'
    )
    $m = Read-EnvFile $f
    $m['PLAIN'] | Should -Be 'value'
    $m['SPACES'] | Should -Be 'Kadai <no-reply@localhost>'
    $m['QUOTED'] | Should -Be 'double quoted'
    $m['SINGLE'] | Should -Be 'single'
    $m['EMPTY'] | Should -Be ''
    $m['EXPORTED'] | Should -Be 'yes'
    $m['DATA'] | Should -Be 'C:\ProgramData\Kadai\data'
    $m['DUP'] | Should -Be '2'
    $m.ContainsKey('double quoted') | Should -BeFalse
  }

  It 'returns an empty map for a missing file' {
    (Read-EnvFile (Join-Path $script:Tmp 'missing.env')).Count | Should -Be 0
  }
}

Describe 'Set-EnvValue' {
  It 'replaces an existing key, appends a new one and keeps other lines' {
    $f = Join-Path $script:Tmp 'b.env'
    Write-Utf8File -Path $f -Lines @('A=1', '# keep', 'KADAI_VERSION=1.0.0')
    Set-EnvValue $f 'KADAI_VERSION' '1.4.0'
    Set-EnvValue $f 'NEW_KEY' 'x y'
    $m = Read-EnvFile $f
    $m['KADAI_VERSION'] | Should -Be '1.4.0'
    $m['NEW_KEY'] | Should -Be 'x y'
    $m['A'] | Should -Be '1'
    (Get-Content -LiteralPath $f) | Should -Contain '# keep'
    @((Get-Content -LiteralPath $f) | Where-Object { $_ -like 'KADAI_VERSION=*' }).Count | Should -Be 1
  }

  It 'writes UTF-8 without a byte order mark (Node.js --env-file)' {
    $f = Join-Path $script:Tmp 'c.env'
    Set-EnvValue $f 'K' 'v'
    $bytes = [IO.File]::ReadAllBytes($f)
    $bytes[0] | Should -Be ([byte][char]'K')
  }
}

Describe 'ConvertFrom-PostgresUrl' {
  It 'splits a connection URL and decodes the password' {
    $c = ConvertFrom-PostgresUrl 'postgres://kadai_owner:p%40ss%3Aword@127.0.0.1:5433/kadai'
    $c.Host | Should -Be '127.0.0.1'
    $c.Port | Should -Be 5433
    $c.User | Should -Be 'kadai_owner'
    $c.Password | Should -Be 'p@ss:word'
    $c.Database | Should -Be 'kadai'
  }

  It 'defaults the port to 5432 and tolerates a missing password' {
    $c = ConvertFrom-PostgresUrl 'postgres://kadai_app@db.local/kadai'
    $c.Port | Should -Be 5432
    $c.Password | Should -Be ''
  }
}

Describe 'random secrets' {
  It 'New-RandomHex returns 2 hex characters per byte' {
    $h = New-RandomHex 24
    $h | Should -Match '^[0-9a-f]{48}$'
    (New-RandomHex 24) | Should -Not -Be $h
  }

  It 'New-RandomBase64 encodes exactly the requested number of bytes' {
    [Convert]::FromBase64String((New-RandomBase64 32)).Length | Should -Be 32
  }
}
