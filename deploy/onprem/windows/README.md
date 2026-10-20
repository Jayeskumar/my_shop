# Kadai Server on Windows (native)

For a shop PC running **Windows 10/11 (64-bit)** or Windows Server 2016+. No Docker needed: the
installer sets up a private Node.js 22 runtime, PostgreSQL 16 and the Windows service
**Kadai Server**. Counter PCs, phones and tablets on the shop network then open
`http://<this-pc>:8080`.

## Install

1. Unpack `kadai-onprem-<version>.zip` (for example to `C:\KadaiSetup`). Put
   `kadai-server-<version>-win-x64.zip` and `SHA256SUMS` from the same release next to it (the
   installer downloads them itself when the PC is online).
2. Start **PowerShell as administrator** and run:

   ```powershell
   cd C:\KadaiSetup\kadai-onprem-<version>
   powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -SetNetworkPrivate -BackupTask
   ```

3. Open the **Kadai** shortcut on the desktop (or `http://localhost:8080`) and complete the setup
   wizard: shop name, GSTIN, owner login. Upload the license in Settings → System.

What the installer does:

| Step          | Details                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 22    | private copy in `C:\Program Files\Kadai\node` (checksum verified); does not touch other Node.js installs                                                                                    |
| PostgreSQL 16 | EDB installer, unattended (signature verified), service `postgresql-x64-16`, port 5432 on this PC only; superuser password saved in `C:\ProgramData\Kadai\secrets` (administrators only)    |
| Database      | roles `kadai_owner` / `kadai_app`, database `kadai`, extensions `pg_trgm`, `citext`                                                                                                         |
| Application   | `C:\Program Files\Kadai\app` (read-only for the service)                                                                                                                                    |
| Configuration | `C:\ProgramData\Kadai\kadai.env` — generated secrets; readable by SYSTEM, Administrators and the service only. **Copy it to a USB drive and keep it safe** (needed to restore on a new PC). |
| Service       | **Kadai Server** (WinSW), automatic (delayed) start after PostgreSQL, runs as `LocalService`, restarts on failure; migrations run on every start                                            |
| Data          | `C:\ProgramData\Kadai\data` (files, backups), logs in `C:\ProgramData\Kadai\logs`                                                                                                           |
| Network       | firewall rule "Kadai Server (TCP 8080, local network)" for Private/Domain networks and the local subnet only                                                                                |
| Extras        | desktop shortcut; with `-BackupTask` a daily backup at 22:45 (Task Scheduler "Kadai Backup")                                                                                                |

Options: `-Port 9090`, `-PublicUrl http://billing-pc:8080`, `-InstallDir`, `-DataRoot`,
`-SkipFirewall`, `-NoShortcut`, `-Yes`. Offline installation: download the files on another PC
and pass `-NodeZip node-v22.x.y-win-x64.zip -PostgresInstaller postgresql-16.x-1-windows-x64.exe
-WinSWExe WinSW-x64.exe -BundlePath kadai-server-<version>-win-x64.zip`. If PostgreSQL 16 is
already installed, the installer asks for its `postgres` password (or pass
`-PostgresSuperPassword (Read-Host -AsSecureString)`).

> **"Public" network?** Windows marks new networks as Public and then blocks counter PCs.
> `-SetNetworkPrivate` switches the shop network to Private; or Settings → Network & Internet →
> (your network) → Network profile type → Private.

## Daily operation

| Task                  | Command (PowerShell as administrator, in `C:\Program Files\Kadai\scripts`)         |
| --------------------- | ---------------------------------------------------------------------------------- |
| Status / restart      | `Get-Service kadai` · `Restart-Service kadai` (or services.msc → Kadai Server)     |
| Logs                  | `Get-Content C:\ProgramData\Kadai\logs\kadai-service.out.log -Tail 100 -Wait`      |
| Backup now            | `.\backup.ps1` (or `-Dest E:\KadaiBackups -Label before-gst-change`)               |
| Restore               | `.\restore.ps1 -File C:\ProgramData\Kadai\data\backups\<file>.dump`                |
| Upgrade               | `.\install.ps1 -Upgrade -BundlePath <path>\kadai-server-<new version>-win-x64.zip` |
| Undo the last upgrade | `.\install.ps1 -Rollback`                                                          |
| Remove (keeps data)   | `.\install.ps1 -Uninstall`                                                         |

Backups: Kadai makes its own daily backup; `-BackupTask` adds a second one. Put
`KADAI_BACKUP_COPY_TO=E:\KadaiBackups` (a USB drive or network share) into `kadai.env` so every
backup is also copied off the PC. Retention: `KADAI_BACKUP_RETENTION_DAYS` (30) /
`KADAI_BACKUP_KEEP_MIN` (7).

Upgrades take a pre-upgrade backup, switch the application folder (the previous one is kept as
`app.prev`), start the service and wait until Kadai is ready; `-Rollback` puts back the previous
version and restores that backup.

More: `docs/DEPLOYMENT.md` (HTTPS for installable POS on counter PCs, payments, SMS/WhatsApp)
and `docs/RUNBOOK.md` (what to do when something goes wrong).
