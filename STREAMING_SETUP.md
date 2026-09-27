# Gints Global Gaming Hubjob Streaming Setup Guide

Complete guide to setting up production-ready game streaming infrastructure with Sunshine and Moonlight support.

## Overview

The Gints Global Gaming Hubjob provides two paths to game streaming:

### Path 1: Sunshine Web UI (Browser)
- No installation required
- Works on any device with a browser
- Built-in performance monitoring and settings
- Best for quick access and configuration

### Path 2: Moonlight (Native Client)
- Hardware-accelerated streaming
- Lowest latency for competitive gaming
- Available for Windows, macOS, Linux, Android, iOS, tvOS
- Best for performance-critical gaming

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Gints Global Gaming Hubjob Frontend (React/Next.js)                    │
│ - Machine manager                                           │
│ - Streaming dashboard                                       │
│ - Performance monitoring                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │ /api/streaming endpoints
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ Gints Global Gaming Hubjob Backend (Node.js/Express)                   │
│ - Streaming routes (streaming.ts)                           │
│ - Machine service with CloudyPadSetup integration           │
│ - Performance & cost tracking                               │
└──────────────────────┬──────────────────────────────────────┘
                       │ SSH setup via CloudyPadSetup
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ Windows Gaming Instance (EC2/Azure/GCP)                     │
│ - NVIDIA GPU (g4dn.xlarge with T4 GPU)                      │
│ - NVIDIA GRID drivers (virtual GPU optimized)               │
│ - CloudyPad framework                                       │
│ - Sunshine streaming server (listens on :47990, :47998)     │
│ - Game launchers (Battle.net, Steam, Epic)                  │
│ - Monitoring agent (metrics collection)                     │
└──────────────────────┬──────────────────────────────────────┘
         │                                    │
         │ HTTP/WebRTC                       │ NVIDIA Streaming Protocol
         │ Port 47990 (Web UI)               │ Port 47998 (Moonlight)
         ↓                                    ↓
    ┌─────────┐                         ┌──────────────┐
    │ Browser │                         │ Moonlight    │
    │ (any)   │                         │ Client       │
    └─────────┘                         └──────────────┘
```

---

## Implementation Steps

### Step 1: Build Custom AMI with Packer

```bash
cd infrastructure/packer

# Validate
packer validate -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

# Build (20-30 minutes)
packer build \
  -var="aws_region=us-east-1" \
  -var="instance_type=g4dn.xlarge" \
  windows-gaming-ami.pkr.hcl

# Outputs:
# ==> Builds finished. The artifacts of successful builds are:
# ==> amazon-ebs.cloudgaming_windows: AMI: ami-0123456789abcdef0

export CUSTOM_AMI_ID="ami-0123456789abcdef0"
```

### Step 2: Update Backend Configuration

**Update `src/services/MachineService.ts`:**

```typescript
// Line 50: Replace old AMI ID with custom AMI
const launchResult = await cloudProvider.launchInstance(
  { region, instanceType },
  {
    imageId: process.env.CUSTOM_GAMING_AMI || 'ami-0123456789abcdef0', // Your Packer-built AMI
    keyName: 'cloudgaming-key',
    securityGroupId: 'sg-0123456789abcdef0',
    spotInstance: true,
  }
);
```

**Or set environment variable:**
```bash
export CUSTOM_GAMING_AMI="ami-0123456789abcdef0"
```

### Step 3: Configure SSH Key

CloudyPadSetup uses SSH to configure instances. Ensure key pair exists:

```bash
# Generate key pair in AWS (one-time)
aws ec2 create-key-pair \
  --key-name cloudgaming-key \
  --region us-east-1 \
  --query 'KeyMaterial' \
  --output text > ~/.ssh/cloudgaming-key.pem

chmod 600 ~/.ssh/cloudgaming-key.pem

# Copy to backend container/server
# Backend looks for: /root/.ssh/cloudgaming-key.pem
cp ~/.ssh/cloudgaming-key.pem /root/.ssh/cloudgaming-key.pem
```

### Step 4: Verify API Integration

The streaming API is automatically integrated. Routes available:

```bash
# Get streaming connection details
curl -H "Authorization: Bearer $JWT_TOKEN" \
  http://localhost:3001/api/streaming/MACHINE_ID

# Get Sunshine web UI URL
curl -H "Authorization: Bearer $JWT_TOKEN" \
  http://localhost:3001/api/streaming/MACHINE_ID/sunshine-web-ui

# Get Moonlight connection string
curl -H "Authorization: Bearer $JWT_TOKEN" \
  -X POST \
  http://localhost:3001/api/streaming/MACHINE_ID/moonlight-connection-string

# Check streaming service status
curl -H "Authorization: Bearer $JWT_TOKEN" \
  http://localhost:3001/api/streaming/MACHINE_ID/streaming-status

# List available streaming clients
curl -H "Authorization: Bearer $JWT_TOKEN" \
  http://localhost:3001/api/streaming/clients
```

### Step 5: Launch Instance and Test

```bash
# Frontend calls
POST /api/machines {
  provider: "aws",
  region: "us-east-1",
  instanceType: "g4dn.xlarge",
  gameTitle: "Elden Ring",
  streamingQuality: "high"
}

# Response includes machineId
# Backend automatically calls CloudyPadSetup.setup()
# Installation happens in background (~15 minutes total)
```

**Timeline:**
- 0-2 min: Instance launching
- 2-10 min: Windows initializing, SSH ready
- 10-20 min: GPU drivers + CloudyPad installation
- 20-30 min: Gaming clients installing in background
- 5 min: Sunshine service started and ready

### Step 6: Connect to Instance

#### Option A: Browser (Sunshine Web UI)

1. **Get URL from API:**
   ```bash
   curl -H "Authorization: Bearer $JWT_TOKEN" \
     http://localhost:3001/api/streaming/{machineId}/sunshine-web-ui
   
   # Response:
   {
     "type": "sunshine-web-ui",
     "url": "http://54.123.45.67:47990",
     "instructions": [...]
   }
   ```

2. **Open in browser:**
   - Navigate to: `http://54.123.45.67:47990`
   - Wait for Sunshine to load (~5 seconds)
   - Login with default credentials (shown in setup)
   - Select game to stream

#### Option B: Moonlight (Native Client)

1. **Get connection details:**
   ```bash
   curl -H "Authorization: Bearer $JWT_TOKEN" \
     -X POST \
     http://localhost:3001/api/streaming/{machineId}/moonlight-connection-string
   
   # Response:
   {
     "protocol": "moonlight",
     "host": "54.123.45.67",
     "port": 47998,
     "format": "moonlight://admin@54.123.45.67:47998",
     "instructions": [...]
   }
   ```

2. **Install Moonlight:**
   - Download: https://github.com/moonlight-stream/moonlight-qt/releases
   - Or mobile app: Android/iOS app stores

3. **Add PC:**
   - Open Moonlight
   - Click "Add Host"
   - Enter: `54.123.45.67:47998`
   - Follow PIN pairing (shown in Sunshine)

4. **Stream game:**
   - Select application from Moonlight library
   - Click "Stream"

---

## Frontend Integration Example

Add streaming UI to your React components:

```typescript
// components/StreamingClient.tsx
import { useEffect, useState } from 'react';

export function StreamingClient({ machineId }: { machineId: string }) {
  const [streaming, setStreaming] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStreamingDetails = async () => {
      const response = await fetch(`/api/streaming/${machineId}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      setStreaming(data.streamingDetails);
      setLoading(false);
    };

    fetchStreamingDetails();
  }, [machineId]);

  if (loading) return <div>Loading streaming details...</div>;

  return (
    <div className="streaming-options">
      <h2>Connect to Gaming Instance</h2>
      
      {/* Sunshine Web UI */}
      <div className="option">
        <h3>🌐 Browser - Sunshine Web UI</h3>
        <p>No installation required</p>
        <a 
          href={streaming.sunshineWebUI.url} 
          target="_blank"
          className="btn btn-primary"
        >
          Open in Browser
        </a>
      </div>

      {/* Moonlight Native Client */}
      <div className="option">
        <h3>🎮 Native Client - Moonlight</h3>
        <p>Lowest latency, best for competitive gaming</p>
        <div className="connection-details">
          <p>Host: <code>{streaming.moonlightClient.host}</code></p>
          <p>Port: <code>{streaming.moonlightClient.port}</code></p>
          <a 
            href={streaming.moonlightClient.downloadUrl}
            target="_blank"
            className="btn btn-secondary"
          >
            Download Moonlight
          </a>
        </div>
      </div>
    </div>
  );
}
```

---

## Monitoring & Performance

### Real-Time Metrics

Access performance data via existing endpoints:
```bash
GET /api/performance/{machineId}
# Returns: CPU, GPU, network, FPS, frame drops, temperatures
```

### Sunshine Built-in Monitoring

Sunshine web UI includes:
- CPU/GPU usage
- FPS counter
- Network statistics
- Bitrate monitoring
- Connection quality

---

## Troubleshooting

### Sunshine Not Responding

**Check instance status:**
```bash
# SSH into instance
ssh -i ~/.ssh/cloudgaming-key.pem Administrator@{IP}

# Verify Sunshine service
Get-Service -Name "Sunshine" | Format-List

# Check logs
Get-Content "C:\Program Files\Sunshine\logs\sunshine.log" -Tail 100

# Restart service
Restart-Service -Name "Sunshine"
```

### Moonlight Connection Fails

1. Verify port 47998 is open:
   ```bash
   # From Moonlight host
   Test-NetConnection -ComputerName {IP} -Port 47998
   ```

2. Check firewall:
   ```powershell
   # On instance
   Get-NetFirewallRule -DisplayName "*Sunshine*"
   ```

3. Regenerate PIN:
   - Sunshine web UI → Settings → PIN
   - Restart pairing process in Moonlight

### High Latency / Frame Drops

**Checklist:**
- [ ] Use wired network connection
- [ ] Reduce quality setting (1080p instead of 1440p)
- [ ] Reduce bitrate (15 Mbps instead of 25 Mbps)
- [ ] Check network: `ping {IP}`
- [ ] Monitor CPU/GPU in Sunshine web UI
- [ ] Verify no other processes using GPU

---

## Cost Optimization

### Instance Selection

| Type | vCPU | GPU | Cost/hr | Best For |
|------|------|-----|---------|----------|
| g4dn.xlarge | 4 | 1×T4 | $0.526 | HD gaming, cost-efficient |
| g4dn.2xlarge | 8 | 1×T4 | $0.752 | 1440p streaming |
| g4dn.12xlarge | 48 | 4×T4 | $3.062 | 4K or multi-user |

### Data Transfer (per GB)
- AWS: $0.02
- Azure: $0.02
- GCP: $0.12
- **Oracle: FREE** (same region)

**Example cost for 1 hour of 1440p gaming:**
- g4dn.xlarge: $0.526 (compute) + $0.25 (egress) = **$0.776/hr**
- Oracle (Singapore): $0.12 (compute) + $0 (free egress) = **$0.12/hr**

---

## Advanced Configuration

### Custom Sunshine Settings

Edit `infrastructure/packer/scripts/05-configure-sunshine.ps1`:

```ini
# High quality (4K)
resolution_width = 3840
resolution_height = 2160
refresh_rate = 60
bitrate = 50000  # 50 Mbps

# Streaming quality encoder selection
encoder = auto  # Or: 'hevc', 'h264', 'auto'
```

### Pre-installed Games

Modify `infrastructure/packer/scripts/04-install-gaming-clients.ps1` to download specific games:

```powershell
# Download game library before image finalization
# Can include: Battle.net titles, Steam games, Epic exclusive
```

### Custom Monitoring

Extend `infrastructure/packer/scripts/06-install-monitoring-agent.ps1` to:
- Collect GPU utilization
- Monitor frame drops
- Track network packet loss
- Alert on thermal throttling

---

## Security Considerations

1. **SSH Key Management**
   - Store private key securely (environment variable or secrets manager)
   - Rotate keys quarterly
   - Never commit to git

2. **Port Security**
   - Port 47990 (Sunshine): Restrict to known IPs if possible
   - Port 47998 (Moonlight): Behind VPN recommended
   - Port 22 (SSH): Close after setup completes

3. **Instance Credentials**
   - Use IAM roles instead of access keys
   - Encrypt cloud credentials in database
   - Rotate credentials monthly

4. **Network**
   - Use VPN for remote access
   - Consider IP whitelist
   - Monitor for unusual connection patterns

---

## Support & Resources

- **Sunshine Docs**: https://docs.lizardbyte.dev/projects/sunshine/
- **Moonlight Project**: https://github.com/moonlight-stream/moonlight-qt
- **CloudyPad**: https://github.com/ReplayCoding/cloudy-pad
- **GitHub Issues**: https://github.com/reganireland-source/cloudgaming/issues

---

## Next Steps

1. ✅ Build Packer AMI with pre-installed streaming
2. ✅ Update backend to use custom AMI
3. ✅ Configure SSH key access
4. ✅ Test machine launch with streaming
5. ✅ Connect via Sunshine Web UI
6. ✅ Connect via Moonlight native client
7. 📊 Monitor performance metrics
8. 💰 Optimize costs based on usage
9. 🔐 Implement security best practices

**Ready to stream!** 🎮
