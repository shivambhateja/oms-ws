# SSH Key Setup for GitHub Actions

## Step 1: Check if you already have SSH keys

Run this command on your local machine:

```bash
ls -la ~/.ssh
```

Look for files like:
- `id_rsa` and `id_rsa.pub` (RSA)
- `id_ed25519` and `id_ed25519.pub` (Ed25519 - recommended)
- `id_ecdsa` and `id_ecdsa.pub` (ECDSA)

If you see a pair (private key without `.pub` and public key with `.pub`), you can use those.

## Step 2: Generate new SSH keys (if you don't have them)

### Option A: Ed25519 (Recommended - more secure)

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/id_ed25519_github
```

### Option B: RSA (if Ed25519 not supported)

```bash
ssh-keygen -t rsa -b 4096 -C "github-actions-deploy" -f ~/.ssh/id_rsa_github
```

**When prompted:**
- Press Enter to accept default location (or specify custom path)
- **Optionally** set a passphrase (recommended for security, but GitHub Actions can handle it)

## Step 3: Get the Private Key

### Display the private key (to copy for GitHub Secrets):

```bash
# For Ed25519:
cat ~/.ssh/id_ed25519_github

# OR for RSA:
cat ~/.ssh/id_rsa_github
```

**Copy the entire output** including:
```
-----BEGIN OPENSSH PRIVATE KEY-----
... (all the content) ...
-----END OPENSSH PRIVATE KEY-----
```

### Display the public key (to add to your server):

```bash
# For Ed25519:
cat ~/.ssh/id_ed25519_github.pub

# OR for RSA:
cat ~/.ssh/id_rsa_github.pub
```

**Example output:**
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... github-actions-deploy
```

## Step 4: Add Public Key to Your Server

### Method 1: Using ssh-copy-id (Easiest)

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_github.pub deploy@your-server-ip
```

### Method 2: Manual (if ssh-copy-id doesn't work)

1. SSH into your server:
```bash
ssh deploy@your-server-ip
```

2. Create/append to authorized_keys:
```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
```

3. Paste the **public key** (the `.pub` file content) into the file
4. Save and set permissions:
```bash
chmod 600 ~/.ssh/authorized_keys
```

5. Test the connection:
```bash
# From your local machine:
ssh -i ~/.ssh/id_ed25519_github deploy@your-server-ip
```

## Step 5: Add Private Key to GitHub Secrets

1. Go to your GitHub repository
2. Navigate to: **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `SSH_PRIVATE_KEY`
5. Value: Paste the **entire private key** (from Step 3)
   - Include the `-----BEGIN` and `-----END` lines
   - Copy everything exactly as shown
6. Click **Add secret**

## Step 6: Verify Setup

After adding the secret, when GitHub Actions runs:
- It will use the private key to SSH into your server
- The server will verify the public key matches
- If successful, deployment proceeds

## Troubleshooting

### If SSH connection fails in GitHub Actions:

1. **Check the private key format:**
   - Must include `-----BEGIN` and `-----END` lines
   - Must be a single continuous block (no line breaks in the middle)

2. **Verify public key is on server:**
   ```bash
   ssh deploy@your-server-ip "cat ~/.ssh/authorized_keys"
   ```

3. **Test SSH connection manually:**
   ```bash
   ssh -i ~/.ssh/id_ed25519_github deploy@your-server-ip
   ```

4. **Check GitHub Actions logs:**
   - Look for SSH connection errors
   - Verify the key is being used correctly

## Security Notes

⚠️ **Important:**
- Never commit private keys to git
- Never share private keys publicly
- The private key in GitHub Secrets is encrypted and secure
- Consider using a dedicated deploy key for CI/CD
- Rotate keys periodically (every 6-12 months)

## Quick Reference

**Private Key** → GitHub Secrets (`SSH_PRIVATE_KEY`)
**Public Key** → Server's `~/.ssh/authorized_keys`

