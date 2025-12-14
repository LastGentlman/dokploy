# Domain Troubleshooting Guide

This guide helps you troubleshoot domain access issues in Dokploy.

## Quick Diagnosis

Run the diagnostic script to check your domain configuration:

```bash
pnpm tsx scripts/diagnose-domain.ts tooljet.ingroy.com
```

## Common Issues and Solutions

### 1. DNS Not Resolving

**Symptoms:**
- Browser shows "This site can't be reached"
- DNS resolution fails

**Solutions:**
1. Verify DNS records point to your server IP:
   ```bash
   dig tooljet.ingroy.com
   # or
   nslookup tooljet.ingroy.com
   ```

2. For A record, ensure it points to your Dokploy server IP
3. Wait for DNS propagation (can take up to 48 hours, usually 5-15 minutes)
4. Check if domain is behind a CDN (Cloudflare, etc.) - this is OK but may need special configuration

### 2. Domain Not Configured in Dokploy

**Symptoms:**
- Domain not found in database
- No Traefik configuration exists

**Solutions:**
1. Go to your application in Dokploy dashboard
2. Navigate to "Domains" tab
3. Add the domain `tooljet.ingroy.com`
4. Configure:
   - **HTTPS**: Enable if you want SSL
   - **Certificate Type**: 
     - `letsencrypt` for automatic SSL (recommended)
     - `custom` if you have your own certificate resolver
   - **Port**: Usually 80 or 3000 (check your application's port)

### 3. Application Not Running

**Symptoms:**
- Application status is not "done"
- Container is not running

**Solutions:**
1. Check application status in Dokploy dashboard
2. Deploy or redeploy the application:
   - Go to application → Deployments tab
   - Click "Deploy" or "Redeploy"
3. Check application logs for errors
4. Verify the application container is running:
   ```bash
   docker ps | grep <app-name>
   ```

### 4. Traefik Configuration Missing

**Symptoms:**
- Domain configured but Traefik config file doesn't exist
- Domain not routing correctly

**Solutions:**
1. Re-add the domain in Dokploy dashboard (this regenerates Traefik config)
2. Or redeploy the application (this also regenerates configs)
3. Check Traefik logs:
   ```bash
   docker logs traefik
   ```

### 5. SSL Certificate Issues

**Symptoms:**
- HTTPS not working
- Certificate errors in browser
- Let's Encrypt certificate not provisioning

**Solutions:**

**For Let's Encrypt:**
1. Ensure domain DNS points to your server (not behind proxy initially)
2. Port 80 must be accessible for HTTP-01 challenge
3. Wait 5-10 minutes for certificate provisioning
4. Check Traefik logs for ACME errors:
   ```bash
   docker logs traefik | grep -i acme
   ```

**For Custom Certificates:**
1. Ensure certificate resolver is configured in Traefik
2. Verify certificate is valid and not expired
3. Check certificate resolver name matches in domain config

### 6. Port Mismatch

**Symptoms:**
- Domain accessible but shows connection refused
- Application not responding

**Solutions:**
1. Check what port your application listens on
2. Verify domain port configuration matches:
   - Check in application Dockerfile/configuration
   - Check domain port setting in Dokploy
3. Common ports:
   - Web apps: 80, 3000, 8080
   - Node.js: 3000, 5000
   - Python: 8000, 5000

### 7. Path Configuration Issues

**Symptoms:**
- Domain works but shows 404
- Path routing incorrect

**Solutions:**
1. Check if you need a path prefix (e.g., `/app`)
2. Configure `path` in domain settings if needed
3. Use `stripPath` if you want to remove the path prefix before forwarding
4. Use `internalPath` if your app expects a different path internally

## Manual Checks

### Check Domain in Database

```sql
SELECT * FROM domain WHERE host = 'tooljet.ingroy.com';
```

### Check Traefik Config

```bash
# Local
cat /etc/dokploy/traefik/dynamic/<app-name>.yml

# Remote (if using remote server)
# Check via Dokploy dashboard or SSH to server
```

### Check Application Container

```bash
docker ps | grep <app-name>
docker logs <container-id>
```

### Check Traefik Logs

```bash
docker logs traefik --tail 100
```

### Test Domain Resolution

```bash
# From your local machine
curl -I http://tooljet.ingroy.com
curl -I https://tooljet.ingroy.com

# From server
curl -I http://localhost -H "Host: tooljet.ingroy.com"
```

## Step-by-Step Fix for tooljet.ingroy.com

1. **Run diagnostic:**
   ```bash
   pnpm tsx scripts/diagnose-domain.ts tooljet.ingroy.com
   ```

2. **Check DNS:**
   ```bash
   dig tooljet.ingroy.com +short
   # Should return your server IP
   ```

3. **Verify in Dokploy:**
   - Go to application dashboard
   - Check "Domains" tab
   - Ensure `tooljet.ingroy.com` is listed
   - Verify HTTPS is enabled if needed
   - Check certificate type is set correctly

4. **Check Application:**
   - Ensure application is deployed and running
   - Check application logs for errors
   - Verify container is running

5. **Check Traefik:**
   ```bash
   docker logs traefik --tail 50 | grep tooljet
   ```

6. **If still not working:**
   - Remove and re-add the domain
   - Redeploy the application
   - Check firewall rules (ports 80, 443 must be open)

## Getting Help

If the issue persists:
1. Run the diagnostic script and share the output
2. Check Traefik logs: `docker logs traefik`
3. Check application logs in Dokploy dashboard
4. Verify DNS propagation: https://dnschecker.org
5. Check server firewall and port accessibility

