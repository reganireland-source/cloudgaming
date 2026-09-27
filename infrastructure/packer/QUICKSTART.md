# Quick Start: Build Gaming AMI

**TL;DR**: One command to build production-ready Windows gaming AMI for AWS Singapore

## Prerequisites (1-time setup)

```bash
# Install Packer
brew install packer

# Verify AWS credentials
aws sts get-caller-identity
```

## Build (30 minutes)

```bash
cd infrastructure/packer

# Option 1: Automated (recommended)
./validate-and-build.sh

# Option 2: Manual
packer validate -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl
packer build -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl
```

## Extract AMI ID

```bash
# After build completes, get the new AMI ID:
cat .ami-id

# Output: ami-0a1b2c3d4e5f6g7h8
```

## Update Backend

**File**: `src/services/MachineService.ts` (line 50)

```typescript
imageId: 'ami-0a1b2c3d4e5f6g7h8'  // Your new AMI from build
```

## Test

```bash
# Launch instance
curl -X POST http://localhost:3001/api/machines \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"provider":"aws","region":"ap-southeast-1","instanceType":"g4dn.xlarge"}'

# Get Sunshine URL
curl http://localhost:3001/api/streaming/MACHINE_ID \
  -H "Authorization: Bearer $TOKEN"

# Open in browser
open http://<instance-ip>:47990
```

## Details

- **What**: Windows Server 2022 with NVIDIA drivers, CloudyPad, Sunshine, gaming clients
- **Where**: AWS Singapore (`ap-southeast-1`)
- **GPU**: NVIDIA T4 (g4dn.xlarge)
- **Time**: 25-30 minutes to build
- **Cost**: ~$0.30 per build
- **Docs**: See `BUILD.md` for detailed steps

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `packer: command not found` | `brew install packer` |
| Build hangs on WinRM | Increase `winrm_timeout` in packer config |
| GPU not detected | Verify g4dn.xlarge available in ap-southeast-1 |
| SSH key error | Run: `aws ec2 create-key-pair --key-name cloudgaming-key --region ap-southeast-1` |

---

**Questions?** See `BUILD.md` or `infrastructure/README.md`
