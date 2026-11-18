# RRchat 1 — Private Server Deployment & Firewall Guide

## 1. Host Prerequisites & Patching
1. Provision a dedicated Linux VPS (Debian 12 / Ubuntu 24.04 LTS).
2. Enable unattended security upgrades:
   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y unattended-upgrades fail2ban nftables ufw age docker.io docker-compose-plugin
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```

## 2. Firewall Configuration (Default-Deny)
Inspect `/infra/firewall/ufw-setup.sh` (or `/infra/firewall/nftables.conf`), replace `203.0.113.0/24` with your administrative VPN/bastion IP CIDR, and apply:
```bash
sudo bash infra/firewall/ufw-setup.sh
```
This blocks PostgreSQL (`5432`) and internal Matrix Synapse ports (`8008`, `9000`) from the public internet while allowing only HTTPS (`443`), ACME HTTP (`80`), and restricted SSH (`22`).

## 3. Secrets & Synapse Initialization
1. Create `/opt/rrchat1/infra/secrets/pg_password.txt` with a strong 32-byte random password (`chmod 600`).
2. Update `chat.example.org` in `infra/synapse/homeserver.yaml` and `infra/caddy/Caddyfile`.
3. Start the isolated stack:
   ```bash
   cd /opt/rrchat1/infra
   docker compose up -d
   ```

## 4. Encrypted Backups & Monitoring
- Add `infra/backup/encrypted-backup.sh` to root cron with `RRCHAT_BACKUP_AGE_PUBKEY` configured.
- Copy `infra/monitoring/fail2ban-jail.local` to `/etc/fail2ban/jail.d/rrchat.local` and restart `fail2ban`.
- **Pre-Launch Requirement (Stage 8)**: Arrange an independent security audit and penetration test before opening public registration.
