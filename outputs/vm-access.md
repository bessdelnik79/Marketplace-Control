# Доступ к тестовой VM

Тестовая среда работает в VirtualBox VM `marketplace_control`. С хост-компьютера SSH доступен через настроенный NAT-проброс:

```powershell
ssh -p 2222 codex@127.0.0.1
```

Рабочий каталог проекта на VM: `/home/codex/marketplace-control`. Приложение работает как системная служба `marketplace-control.service` и слушает порт `3000` внутри VM.

Быстрая итоговая проверка:

```bash
cd /home/codex/marketplace-control
git log -1 --oneline
npm test
systemctl --no-pager --full status marketplace-control.service
curl -fsS http://127.0.0.1:3000/health
```

Пароль и другие учётные данные в репозитории не сохраняются.
