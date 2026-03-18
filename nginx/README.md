# Nginx Configuration for FreezeDry Node

## Quick Setup

```bash
# 1. Copy config
sudo cp nginx/freezedry-node.conf /etc/nginx/sites-enabled/freezedry-node

# 2. Edit: replace YOUR_DOMAIN_HERE with your actual domain
sudo nano /etc/nginx/sites-enabled/freezedry-node

# 3. Add SSL with certbot
sudo certbot --nginx -d your.domain.com

# 4. Harden nginx.conf — add inside http {} block:
#    server_tokens off;

# 5. Test + reload
sudo nginx -t && sudo systemctl reload nginx
```

## Security Checklist

- [ ] Node binds to `127.0.0.1` (default in v2+, set `BIND_HOST` env if needed)
- [ ] `server_tokens off` in `/etc/nginx/nginx.conf`
- [ ] Only explicit endpoints exposed (no wildcard `location /` proxy)
- [ ] SSL/TLS via certbot (TLSv1.2+ only)
- [ ] Rate limiting on all endpoints
- [ ] Dotfiles blocked (`location ~ /\.`)
- [ ] No internal ports (3100, 8080, etc.) accessible externally
- [ ] Disable unused services: `sudo systemctl disable --now rpcbind`

## Exposed Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Node status |
| `/artworks` | GET | List indexed artworks |
| `/artwork/:hash` | GET | Single artwork metadata |
| `/blob/:hash` | GET | Serve blob data |
| `/verify/:hash` | GET | Hash verification |
| `/nodes` | GET | Registered peers |
| `/webhook/helius` | POST | Chain event webhook |
| `/sync/*` | GET/POST | Node-to-node sync |
| `/marketplace/*` | GET | Job marketplace status |
| `/upload/:hash` | PUT | Direct upload (writer only, optional) |
