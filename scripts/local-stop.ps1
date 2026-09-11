$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker не установлен.'
}

docker compose down
if ($LASTEXITCODE -ne 0) {
    throw 'Не удалось остановить локальное окружение.'
}

