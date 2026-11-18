#!/usr/bin/env bash
set -euo pipefail

# RRchat 1 Host Firewall Setup (UFW)
# Policy: Default-deny all inbound connections; allow only HTTPS (443), ACME HTTP (80), and restricted SSH.

ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Restrict SSH to your administrative VPN/bastion CIDR in production
# Replace 203.0.113.0/24 with your actual admin static IP or WireGuard CIDR
ufw allow from 203.0.113.0/24 to any port 22 proto tcp comment 'Admin SSH only'

# Public TLS / HTTPS and ACME HTTP challenge
ufw allow 80/tcp comment 'HTTP ACME / redirect to HTTPS'
ufw allow 443/tcp comment 'HTTPS TLS 1.3'
ufw allow 443/udp comment 'HTTP/3 QUIC'

# Explicitly ensure PostgreSQL (5432) and Synapse internal ports (8008, 9000) are denied externally
ufw deny in 5432/tcp comment 'Block PostgreSQL'
ufw deny in 8008/tcp comment 'Block internal Synapse HTTP'
ufw deny in 9000/tcp comment 'Block Synapse metrics'

ufw --force enable
ufw status verbose
