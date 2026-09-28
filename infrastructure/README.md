# Gints Global Gaming Hubjob Infrastructure

Production-ready infrastructure setup for cloud gaming with Sunshine streaming and GamePad support across AWS, Azure, GCP, and Oracle Cloud.

## Components

### 1. Packer AMI Builder (`packer/`)

Builds Windows Server 2022 AMI with pre-installed streaming infrastructure:
- NVIDIA GPU drivers (GRID-optimized for virtual GPUs)
- CloudyPad streaming framework
- Sunshine streaming server (NVIDIA-optimized)
- Battle.net launcher + gaming clients
- Gints Global Gaming Hubjob monitoring agent
- Auto-start services

### 2. CloudyPad Setup Utility (`src/utils/CloudyPadSetup.ts`)

Remote configuration via SSH that:
- Installs GPU drivers
- Sets up Sunshine with quality-specific configuration
- Configures streaming parameters (1440p 60fps default)
- Installs gaming clients (Battle.net, Steam, Epic)
- Starts streaming services

### 3. Streaming API Endpoints (`src/api/routes/streaming.ts`)

Exposes streaming client connection details:
- `/api/streaming/:machineId` - Connection details for both clients
- `/api/streaming/:machineId/sunshine-web-ui` - Browser-based access
- `/api/streaming/:machineId/moonlight-connection-string` - Native client info
- `/api/streaming/:machineId/streaming-status` - Real-time service health

## Quick Start: Building Custom AMI

### Prerequisites
```bash
# Install Packer
brew install packer  # macOS
# OR visit https://www.packer.io/downloads

# AWS CLI configured
aws configure
```

### Build AMI
```bash
cd infrastructure/packer

# Validate configuration
packer validate -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

# Build AMI (takes 20-30 minutes)
packer build \
  -var="aws_region=us-east-1" \
  -var="instance_type=g4dn.xlarge" \
  windows-gaming-ami.pkr.hcl

# Output will show new AMI ID: ami-xxxxxxxxx
```

### Register AMI with CloudGaming

Update `src/services/MachineService.ts`:
```typescript
// In launchMachine() method, replace:
imageId: 'ami-0c55b159cbfafe1f0', // Old Windows Server base

// With your new custom AMI:
imageId: 'ami-xxxxxxxxx', // Your CloudyPad-enabled AMI
```

## Architecture

```
Instance Launch Flow:
1. API receives /api/machines POST request
2. CloudProvider.launchInstance() creates EC2/Azure/GCP instance
3. MachineService.setupSunshine() calls CloudyPadSetup.setup()
4. CloudyPadSetup:
   - Waits for instance SSH ready (10 min timeout)
   - Installs NVIDIA drivers (5-10 min)
   - Installs CloudyPad/Sunshine (5 min)
   - Configures quality settings
   - Installs gaming clients (background)
   - Starts Sunshine service
5. Returns Sunshine web UI URL
6. User connects via Sunshine Web UI (http://ip:47990)
   OR native Moonlight client (ip:47998)
```

## Streaming Clients

### Sunshine Web UI (Browser)
- **URL**: `http://<instance-ip>:47990`
- **No installation** required
- **Supports**: Windows, macOS, Linux, Android, iOS
- **Best for**: Quick access, troubleshooting, configuration
- **Access** from frontend: `GET /api/streaming/:machineId/sunshine-web-ui`

### Moonlight (Native Client)
- **Download**: https://github.com/moonlight-stream/moonlight-qt/releases
- **Connection**: `<instance-ip>:47998`
- **Supports**: Windows, macOS, Linux, Android, iOS, tvOS
- **Best for**: Lowest latency, competitive gaming
- **Hardware acceleration**: Built-in video decoding
- **Access** from frontend: `POST /api/streaming/:machineId/moonlight-connection-string`

## Configuration

### Quality Tiers (from CloudyPadSetup)

```typescript
budget:   1280x720   30fps   5 Mbps    2.25 GB/hr
good:     1920x1080  60fps  12 Mbps    5.4 GB/hr
high:     2560x1440  60fps  25 Mbps   11.25 GB/hr  ← Default
ultra:    3840x2160  60fps  50 Mbps   22.5 GB/hr
```

Directly configured in Sunshine (`config/sunshine.conf`):
```ini
resolution_width = 2560
resolution_height = 1440
refresh_rate = 60
bitrate = 25000  # 25 Mbps
encoder = auto
autogpu = true
```

### Auto-Start Services

Windows scheduled tasks configured in Packer:
- **Sunshine**: Auto-starts at system boot
- **Metrics Collector**: Runs every minute, posts to `/api/performance`
- **Gaming Clients**: Install in background (can take 15+ min)

Verify with:
```powershell
# On instance
Get-Service -Name "Sunshine"
Get-ScheduledTask -Path "\CloudGaming\"
```

## SSH Setup for CloudyPad

CloudyPadSetup requires SSH access to Windows instances:

```typescript
// Required environment variables
SSH_KEY_PATH = '/root/.ssh/cloudgaming-key.pem'  // SSH private key
SSH_USERNAME = 'Administrator'  // Windows default user

// Key pair must be created in AWS and downloaded beforehand
// Then copied to ./ssh/cloudgaming-key.pem
```

### Generate Key Pair (one-time)
```bash
# In AWS Console or CLI
aws ec2 create-key-pair \
  --key-name cloudgaming-key \
  --region us-east-1 \
  --query 'KeyMaterial' \
  --output text > ~/.ssh/cloudgaming-key.pem

chmod 600 ~/.ssh/cloudgaming-key.pem
```

### Verify SSH Connectivity
```bash
# From CloudGaming backend server
ssh -i ~/.ssh/cloudgaming-key.pem \
  Administrator@<instance-ip> \
  "echo 'SSH ready'"
```

## Deployment Checklist

- [ ] Build custom AMI with Packer
- [ ] Update `src/services/MachineService.ts` with new AMI ID
- [ ] Verify SSH key exists at `/root/.ssh/cloudgaming-key.pem`
- [ ] Set `SSH_KEY_PATH` environment variable if different
- [ ] Test instance launch and Sunshine access
- [ ] Verify streaming endpoints work (`/api/streaming/:machineId`)
- [ ] Test Sunshine Web UI at `http://<ip>:47990`
- [ ] Test Moonlight client connection to `<ip>:47998`

## Monitoring & Troubleshooting

### Check Instance Setup Status
```bash
# SSH into instance
ssh -i ~/.ssh/cloudgaming-key.pem Administrator@<ip>

# Verify Sunshine is running
Get-Service -Name "Sunshine"

# Check Sunshine logs
Get-Content "C:\Program Files\Sunshine\logs\sunshine.log" -Tail 50

# Check GPU drivers
wmic path win32_videocontroller get name,description

# Verify web UI is accessible
curl http://localhost:47990
```

### Common Issues

**Issue**: "SSH connection timeout"
- Ensure security group allows port 22 (SSH)
- Verify instance has public IP assigned
- Wait 2-3 minutes for Windows initialization

**Issue**: "Sunshine service not running"
- Check `C:\Program Files\Sunshine\logs\sunshine.log`
- Verify GPU drivers installed correctly
- Manually start: `Start-Service -Name Sunshine`

**Issue**: "GPU not detected"
- Check instance type supports GPU (g4dn, a100, etc.)
- Verify NVIDIA driver installation in Control Panel
- Reboot instance: `Restart-Computer -Force`

**Issue**: "Web UI shows blank / not loading"
- Check firewall: `Get-NetFirewallRule | ? {$_.LocalPort -eq 47990}`
- Verify Sunshine is running: `Get-Service Sunshine`
- Check port 47990 is accessible from network

## Cost Optimization

### Instance Types (g4dn family recommended)
```
g4dn.xlarge    $0.526/hr + egress   ← Most cost-effective for HD
g4dn.2xlarge   $0.752/hr + egress   ← Better 4K performance
g4dn.12xlarge  $3.062/hr + egress   ← Multi-user/streaming
```

### Data Transfer
- **AWS**: $0.02/GB egress (except Oracle free egress)
- **Azure**: $0.02/GB data transfer out
- **Oracle**: **FREE** data transfer (same region)
- **GCP**: $0.12/GB

**Recommendation**: Use Oracle Cloud + Singapore region for minimal egress costs.

## Advanced Configuration

### Custom Sunshine Configuration
Edit scripts in `packer/scripts/05-configure-sunshine.ps1` to modify:
- Resolution/FPS for different use cases
- Audio channels and frequency
- Network settings (ports, UPnP)
- Encoder selection (auto, NVIDIA NVENC, AMD VCE, Intel QSV)

### Gaming Client Pre-configuration
Modify `packer/scripts/04-install-gaming-clients.ps1` to:
- Pre-install additional game launchers
- Download game libraries
- Configure client auto-login
- Set up performance profiles

### Performance Tuning
See `packer/scripts/07-cleanup-optimize.ps1` for:
- Disk optimization (SSD recommended)
- Windows service tuning
- Memory/cache optimization
- GPU clock speed management

## References

- **Sunshine**: https://github.com/LizardByte/Sunshine
- **CloudyPad**: https://github.com/ReplayCoding/cloudy-pad
- **Moonlight**: https://github.com/moonlight-stream/moonlight-qt
- **Packer**: https://www.packer.io/docs
- **AWS EC2**: https://aws.amazon.com/ec2/

## Support

Issues or improvements? Open an issue at:
your repository's Issues page on GitHub

For streaming setup help:
- Sunshine: https://github.com/LizardByte/Sunshine/discussions
- Moonlight: https://github.com/moonlight-stream/moonlight-qt/discussions
