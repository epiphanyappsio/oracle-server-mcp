FINISHED - November 26, 2026

# oracle-server-mcp

MCP server that lets Claude run commands on the Oracle server. Runs in Coolify.

## Tools

- ping: shows if host access is on
- run_command: run a bash command (Claude asks you to approve each call)
- read_file: read a file
- write_file: write a file (saves a .bak copy first)

Always refused: deleting the root folder, formatting disks, dropping databases, force push, reboot/shutdown, Docker prune and volume deletes.

## Deploy in Coolify

1. Add resource > Public Repository > paste this repo URL.
2. Build Pack: Docker Compose.
3. Environment Variables: set MCP_TOKEN to a random string of at least 64 characters. Never put it in the repo.
4. Domains: add a domain for service oracle-server-mcp:

```
https://mcp.epiphanyapps.io:3000
```

5. Deploy. Then open https://mcp.epiphanyapps.io/health. It should show {"ok":true}.
6. Cloudflare: SSL/TLS > Overview > Full (strict).

## Connect Claude

Customize > Connectors > Add custom connector.

```
https://mcp.epiphanyapps.io/mcp
```

Request headers: Authorization = Bearer YOUR_MCP_TOKEN

## Test

Ask Claude to run: hostname

- Shows the Oracle server name: host access works.
- Shows a random container id: the Docker socket was not mounted. Check the deployment log.

## Docs

- [Coolify Docker Compose build pack](https://coolify.io/docs/applications/build-packs/docker-compose)
- [Coolify bind mounts](https://coolify.io/docs/core/persistent-storage/storage-mounts/bind-mounts)
- [Custom connectors in Claude](https://support.claude.com/en/articles/11175166)

## Security

Anyone with MCP_TOKEN can run commands as root on the server. Use a long random token, keep it secret, rotate it if it leaks, and remove the connector when not in use.

Claude Sonnet 5.5 ⚡
