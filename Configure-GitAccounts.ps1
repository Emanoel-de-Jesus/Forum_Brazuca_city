$ErrorActionPreference = 'Stop'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git não foi encontrado no PATH.'
}

$homeDirectory = [Environment]::GetFolderPath('UserProfile')
$personalConfig = Join-Path $homeDirectory '.gitconfig-github-pessoal'
$workConfig = Join-Path $homeDirectory '.gitconfig-github-trabalho'
$personalConfigForGit = $personalConfig.Replace('\', '/')
$workConfigForGit = $workConfig.Replace('\', '/')

function Set-GitConfigFileValue {
    param(
        [string[]]$Arguments
    )

    & git config @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao executar: git config $($Arguments -join ' ')"
    }
}

Set-GitConfigFileValue -Arguments @('--file', $personalConfig, '--replace-all', 'user.name', 'Emanoel De Jesus Barbosa Santos')
Set-GitConfigFileValue -Arguments @('--file', $personalConfig, '--replace-all', 'user.email', 'emanoeljesus610@gmail.com')
Set-GitConfigFileValue -Arguments @('--file', $personalConfig, '--replace-all', 'credential.https://github.com.username', 'Emanoel-de-Jesus')
Set-GitConfigFileValue -Arguments @('--file', $workConfig, '--replace-all', 'user.name', 'Emanoel De Jesus Barbosa Santos')
Set-GitConfigFileValue -Arguments @('--file', $workConfig, '--replace-all', 'user.email', 'emanoel.jesus2025@seducbertioga.com.br')
Set-GitConfigFileValue -Arguments @('--file', $workConfig, '--replace-all', 'credential.https://github.com.username', 'emanoeljesus2025-art')

$obsoleteIncludes = @(
    'includeIf.hasconfig:remote.*.url:*github.com*Emanoel-de-Jesus/**.path',
    'includeIf.hasconfig:remote.*.url:*github.com*emanoeljesus2025-art/**.path'
)
foreach ($key in $obsoleteIncludes) {
    & git config --global --unset-all $key 2>$null
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 5) {
        throw "Não foi possível atualizar a regra global '$key'."
    }
}

$accountIncludes = @(
    @{ Pattern = 'https://github.com/Emanoel-de-Jesus/**'; Config = $personalConfigForGit },
    @{ Pattern = '*github.com:Emanoel-de-Jesus/**'; Config = $personalConfigForGit },
    @{ Pattern = 'ssh://git@github.com/Emanoel-de-Jesus/**'; Config = $personalConfigForGit },
    @{ Pattern = 'https://github.com/emanoeljesus2025-art/**'; Config = $workConfigForGit },
    @{ Pattern = '*github.com:emanoeljesus2025-art/**'; Config = $workConfigForGit },
    @{ Pattern = 'ssh://git@github.com/emanoeljesus2025-art/**'; Config = $workConfigForGit }
)
foreach ($include in $accountIncludes) {
    Set-GitConfigFileValue -Arguments @(
        '--global',
        '--replace-all',
        "includeIf.hasconfig:remote.*.url:$($include.Pattern).path",
        $include.Config
    )
}

$repoRoot = & git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -eq 0 -and $repoRoot) {
    $repoRoot = $repoRoot.Trim()
    $remoteOutput = & git -C $repoRoot remote -v
    if ($LASTEXITCODE -ne 0) {
        throw 'Não foi possível consultar os remotes do repositório atual.'
    }

    $hasKnownAccountRemote = $remoteOutput -match 'github\.com[:/]Emanoel-de-Jesus/' -or
        $remoteOutput -match 'github\.com[:/]emanoeljesus2025-art/'

    if ($hasKnownAccountRemote) {
        foreach ($setting in @('user.name', 'user.email')) {
            & git -C $repoRoot config --local --unset-all $setting 2>$null
            if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 5) {
                throw "Não foi possível remover a configuração local '$setting'."
            }
        }
    }
}

Write-Output 'Configuracao instalada. A identidade de commits sera escolhida pelo dono do remote GitHub.'
if ($hasKnownAccountRemote) {
    Write-Output "Projeto atual: $(git -C $repoRoot config user.name) <$(git -C $repoRoot config user.email)>"
}
