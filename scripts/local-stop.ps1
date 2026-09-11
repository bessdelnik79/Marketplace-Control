$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker не установлен.'
}

$compose = Get-Command docker-compose -ErrorAction SilentlyContinue
if (-not $compose) {
    throw 'Docker Compose не найден.'
}

& $compose.Source down
if ($LASTEXITCODE -ne 0) {
    throw 'Не удалось остановить локальное окружение.'
}
