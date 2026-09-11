$ErrorActionPreference = 'Stop'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker не установлен. Установите Docker Desktop и повторите команду.'
}

docker compose up --detach --wait postgres
if ($LASTEXITCODE -ne 0) {
    throw 'Не удалось запустить локальный PostgreSQL.'
}

docker compose exec --no-TTY postgres sh -c `
    'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 --command "SELECT version, applied_at FROM mc.schema_migrations ORDER BY version;"'

if ($LASTEXITCODE -ne 0) {
    throw 'PostgreSQL запущен, но проверка миграции завершилась ошибкой.'
}

Write-Host 'Marketplace Control: локальная база готова на 127.0.0.1.'
