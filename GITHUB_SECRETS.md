# GitHub Secrets Required for WebSocket Service Deployment

## Required Secrets

Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):

### SSH Connection (Shared with Next.js deployment)
- `SSH_HOST` - Your server hostname or IP address
- `SSH_USER` - SSH username (e.g., `deploy`)
- `SSH_PORT` - SSH port (usually `22`)
- `SSH_PRIVATE_KEY` - Your SSH private key for authentication

### WebSocket Service Environment Variables
- `WS_PORT` - WebSocket port (default: `8080`, optional)
- `OPENAI_API_KEY` - OpenAI API key (required)
  - **OR** `GOOGLE_GENERATIVE_AI_API_KEY` - If you only have this, the workflow will use it
- `OUTREACH_API_URL` - Outreach API URL (optional, only if you use outreach features)

## How It Works

The GitHub Action will:
1. SSH into your server
2. Navigate to `~/oms-ws`
3. Pull latest code from `main` branch
4. Create `.env` file from GitHub secrets
5. Build and restart only the `backend-ws` Docker container

## Secret Priority

For `OPENAI_API_KEY`, the workflow checks:
1. First: `secrets.OPENAI_API_KEY`
2. Fallback: `secrets.GOOGLE_GENERATIVE_AI_API_KEY`

So you can add either one, or both (it will prefer `OPENAI_API_KEY`).

## Notes

- The `.env` file is created on each deployment, so secrets are always fresh
- The workflow only deploys `backend-ws` service, not the entire stack
- If you already have these SSH secrets for Next.js deployment, you can reuse them

