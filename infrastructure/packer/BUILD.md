# Building Custom Gaming AMI for AWS Singapore

**Region**: `ap-southeast-1` (Singapore)  
**Instance Type**: `g4dn.xlarge` (NVIDIA T4 GPU)  
**Build Time**: ~25-30 minutes  
**Output**: Production-ready AMI with pre-installed drivers, CloudyPad, Sunshine, and gaming clients

---

## Pre-Build Checklist

### 1. AWS Credentials & Permissions
- [ ] AWS CLI installed: `aws --version`
- [ ] Credentials configured: `aws configure`
- [ ] Region set to Singapore: `export AWS_REGION=ap-southeast-1`
- [ ] IAM permissions include:
  - [ ] `ec2:RunInstances`
  - [ ] `ec2:TerminateInstances`
  - [ ] `ec2:CreateImage`
  - [ ] `ec2:CreateSnapshot`
  - [ ] `ec2:DescribeImages`
  - [ ] `ec2:DescribeSecurityGroups`

### 2. Packer Installation
```bash
# macOS
brew install packer

# Or download from: https://www.packer.io/downloads
packer version  # Should be 1.8.0+
```

### 3. SSH Key Pair (for instance configuration)
```bash
# Check if key exists in Singapore region
aws ec2 describe-key-pairs --region ap-southeast-1

# If NOT exist, create it
aws ec2 create-key-pair \
  --key-name cloudgaming-key \
  --region ap-southeast-1 \
  --query 'KeyMaterial' \
  --output text > ~/.ssh/cloudgaming-key.pem

chmod 600 ~/.ssh/cloudgaming-key.pem

# Verify
ls -la ~/.ssh/cloudgaming-key.pem
```

### 4. Security Group (for WinRM access during build)
- [ ] Default VPC security group allows:
  - Port 5985 (WinRM) from Packer builder IP
  - Port 22 (SSH) from CloudGaming backend
  
Packer creates temporary security group automatically, but ensure account allows it.

### 5. Disk Space
- [ ] Local: ~15GB free (temporary instance EBS snapshots)
- [ ] S3: ~5GB free (not needed unless using S3 for snapshots)

---

## Build Steps

### Step 1: Validate Configuration
```bash
cd infrastructure/packer

# Validate syntax and configuration
packer validate -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

# Expected output:
# The configuration is valid.
```

### Step 2: Format Check (optional)
```bash
packer fmt windows-gaming-ami.pkr.hcl
```

### Step 3: Build AMI

**Option A: Quick Build (recommended)**
```bash
# Build with default variables from vars.pkr.hcl
packer build -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

# Watch build progress in console
# Total time: 25-30 minutes
```

**Option B: Custom Variables**
```bash
# Override specific variables
packer build \
  -var="aws_region=ap-southeast-1" \
  -var="instance_type=g4dn.xlarge" \
  -var="root_volume_size=100" \
  windows-gaming-ami.pkr.hcl
```

**Option C: Debug Mode (if issues):**
```bash
# Enable debug logging
PACKER_LOG=1 packer build -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

# Save build logs
packer build -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl 2>&1 | tee build.log
```

### Step 4: Monitor Build Progress

Watch the build console for stages:

```
✓ Validating AMI Name... (1 min)
✓ Waiting for Instance... (2 min)
✓ Waiting for WinRM... (3-5 min)
✓ Windows Updates... (5-10 min)
✓ Installing NVIDIA Drivers... (10-15 min)
✓ Installing CloudyPad/Sunshine... (5 min)
✓ Installing Gaming Clients... (5-10 min)
✓ Configuring Services... (2 min)
✓ Cleanup & Optimization... (3-5 min)
✓ Creating AMI... (2-3 min)
```

### Step 5: Capture AMI ID

```
Build 'amazon-ebs.cloudgaming_windows' finished after 27 minutes 43 seconds.

==> Builds finished. The artifacts of successful builds are:

==> amazon-ebs.cloudgaming_windows: AMI: ami-0a1b2c3d4e5f6g7h8
    amazon-ebs.cloudgaming_windows: Created tags on ami 'ami-0a1b2c3d4e5f6g7h8'
    ...
```

**Save the AMI ID:**
```bash
# Export for use in backend
export CLOUDGAMING_AMI_ID="ami-0a1b2c3d4e5f6g7h8"
echo $CLOUDGAMING_AMI_ID

# Or save to file
echo "ami-0a1b2c3d4e5f6g7h8" > .ami-id
```

### Step 6: Verify AMI in AWS Console

```bash
# List newly created AMI
aws ec2 describe-images \
  --region ap-southeast-1 \
  --owners self \
  --query 'Images[0].[ImageId,Name,CreationDate,State]' \
  --output table

# Expected output:
# |  ImageId       | Name                                | CreationDate         | State   |
# |  ami-xxxxx     | cloudgaming-gaming-ami-sg-2024-... | 2024-01-15T10:30:... | available |
```

---

## Post-Build Configuration

### 1. Update Backend Code

**File**: `src/services/MachineService.ts` (line 50)

```typescript
// Before:
imageId: 'ami-0c55b159cbfafe1f0',  // Generic Windows Server

// After:
imageId: process.env.CLOUDGAMING_AMI_ID || 'ami-0a1b2c3d4e5f6g7h8',
```

### 2. Set Environment Variable

**Option A: Docker/Container**
```bash
# In docker-compose.yml or Dockerfile
ENV CLOUDGAMING_AMI_ID="ami-0a1b2c3d4e5f6g7h8"
```

**Option B: Local Development**
```bash
# Add to .env or .env.local
CLOUDGAMING_AMI_ID=ami-0a1b2c3d4e5f6g7h8
```

**Option C: Production (Railway/Heroku)**
```bash
# Set via environment variable
railway variable set CLOUDGAMING_AMI_ID=ami-0a1b2c3d4e5f6g7h8
```

### 3. Test Instance Launch

```bash
# Frontend: POST /api/machines
curl -X POST http://localhost:3001/api/machines \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "aws",
    "region": "ap-southeast-1",
    "instanceType": "g4dn.xlarge",
    "gameTitle": "Test Game",
    "streamingQuality": "high"
  }'

# Backend will:
# 1. Launch instance with custom AMI
# 2. Call CloudyPadSetup to verify (should be quick - most work pre-done)
# 3. Return machineId
```

### 4. Verify Streaming Works

```bash
# Get streaming connection details
curl http://localhost:3001/api/streaming/{machineId} \
  -H "Authorization: Bearer $JWT_TOKEN"

# Open Sunshine Web UI
# http://<instance-ip>:47990
```

---

## Troubleshooting

### Build Fails: "No space left on device"
- Packer instance ran out of disk
- Solution: Increase root_volume_size in vars.pkr.hcl (default 100GB should be enough)

### Build Fails: "WinRM timeout"
- Windows taking too long to initialize or WinRM not responding
- Solution: 
  - Increase timeout in packer config: `winrm_timeout = "30m"` → `"45m"`
  - Check security group allows port 5985
  - Wait a bit longer and retry

### Build Fails: "GPU driver installation failed"
- g4dn.xlarge not available in Singapore or driver download failed
- Solution:
  - Verify instance type available: `aws ec2 describe-instance-types --region ap-southeast-1 --filter "Name=instance-type,Values=g4dn.xlarge"`
  - Check NVIDIA driver URL is still valid
  - Manually download driver and host on S3, update script

### Build Fails: "Gaming client installation timeout"
- Battle.net or Steam installer taking too long
- Solution:
  - This is non-critical (background install)
  - Extend timeout in scripts or skip optional clients
  - Clients can be installed manually after instance launch

### AMI Build Succeeds but Instance Won't Start
- AMI created but instance launch fails
- Causes: 
  - SecurityGroup doesn't exist in target region
  - Key pair doesn't exist
  - Insufficient capacity for instance type
- Solution: Check error in CloudGaming backend logs

---

## Cost Impact

**Build Cost** (one-time):
- EC2 instance: 30 min × $0.526/hr = ~$0.26
- EBS snapshot: Minimal (cleaned up after build)
- **Total: ~$0.30 per build**

**Deployment Cost** (per instance):
- Pre-built AMI saves: 15 min of setup time
- Estimated saving: 15 min × $0.526/hr = **$0.13 per instance**
- Breaks even after 3 instances, huge savings at scale

---

## Next Steps

1. ✅ Run `packer validate` to check configuration
2. ✅ Run `packer build` to create AMI (25-30 min)
3. ✅ Copy AMI ID to environment variable
4. ✅ Update backend code with new AMI ID
5. ✅ Test instance launch with CloudyPadSetup
6. ✅ Verify Sunshine Web UI and Moonlight access
7. 📊 Monitor instance costs and performance

---

## References

- **Packer Docs**: https://www.packer.io/docs
- **AWS g4dn instances**: https://aws.amazon.com/ec2/instance-types/g4/
- **Windows Server pricing**: https://aws.amazon.com/windows/pricing/
- **Singapore region**: https://aws.amazon.com/regions/asia-pacific/

**Questions?** Check `infrastructure/README.md` for detailed architecture notes.
